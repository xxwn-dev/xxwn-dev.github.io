---
title: 성공했다는데 오지 않는 야속한 뉴스 알림
description: pitch-feed 배포·테스트 트러블슈팅
pubDatetime: 2026-03-25T10:00:00+09:00
tags:
  - pitch-feed
---
> Spring Boot 배치 시스템을 Render에 배포하고 GitHub Actions로 자동화하는 과정에서 겪은 트러블슈팅 5가지를 기록합니다.  
> Discord 웹훅 연동, GitHub Actions 타임아웃, Spring Security 슬라이스 테스트, Virtual Thread 병렬화를 다룹니다.  
  
---  
  
## 프로젝트 개요  
  
`pitch-feed`는 KBO RSS 피드를 수집해 Spring AI로 요약하고 Discord로 발송하는 배치 시스템입니다.  
  
```  
RSS → @Scheduled → Spring AI(요약/태그) → PostgreSQL → Discord  
```  
  
Render에 서버를 올리고 GitHub Actions로 배치를 트리거하는 구조입니다.  
  
---  
  
## 이슈 1 — Discord 알림 미수신 (Render IP 차단)  
  
**증상**  
GitHub Actions 배치 트리거 성공, 기사 DB 저장 정상, Discord 알림만 오지 않음.  
  
**원인**  
Render 무료 티어는 IP를 여러 고객과 공유합니다. 다른 사용자의 남용으로 인해 해당 IP가 Cloudflare에 의해 **429 error code 1015**로 지속 차단된 상태였습니다. 웹훅 URL을 새로 생성해도 서버 IP가 동일하므로 해결되지 않습니다.  
  
로컬 `curl` 테스트로 차단 여부를 먼저 확인할 수 있습니다.  
  
```bash  
# 로컬 IP → 204 (정상)  
curl -s -o /dev/null -w "%{http_code}" \  
  -X POST $DISCORD_WEBHOOK \  -H "Content-Type: application/json" \  -d '{"content":"test"}'  
# Render IP → 429 (차단)  
```  
  
**해결 — Discord 호출 주체를 GitHub Actions로 이동**  
  
```  
Before: Render → Discord webhook (직접 호출)  
After:  Render → Discord payload JSON 반환 → GitHub Actions → Discord webhook
```  
  
Render는 RSS 수집·AI 요약·DB 저장만 담당하고 Discord payload를 JSON으로 반환합니다. Discord 호출은 GitHub Actions가 담당합니다. GitHub Actions 실행 IP는 차단 대상이 아닙니다.  
  
```yaml  
# GitHub Actions workflow  
- name: Trigger batch  
  run: |    curl -o /tmp/discord_payload.json $RENDER_BATCH_URL  
- name: Send Discord notification  
  run: |    curl -X POST $DISCORD_WEBHOOK \         -H "Content-Type: application/json" \         -d @/tmp/discord_payload.json  
```  
  
**교훈**: 무료 티어 공유 IP는 언제든 제3자 사유로 차단될 수 있습니다. 외부 서비스 호출은 IP를 통제할 수 있는 쪽에서 담당하도록 분리하는 것이 안전합니다.  
  
---  
  
## 이슈 2 — GitHub Actions curl timeout (exit code 28)  
  
**증상**  
```  
Process completed with exit code 28  
```  
  
`--max-time` 제한을 초과하면 curl이 exit code 28을 반환합니다.  
  
**원인**  
`--max-time 180` 설정이 실제 실행 시간보다 짧았습니다.  
  
| 단계 | 소요 시간 |  
|------|-----------|  
| Render 콜드 스타트 | ~100초 |  
| AI 요약 5건 × ~30초 (직렬) | ~150초 |  
| **합계** | **~250초** |  
  
**해결 (임시)**  
```yaml  
curl --max-time 360 $RENDER_BATCH_URL  
```  
  
단순히 제한 시간을 늘리는 것은 임시 조치입니다. AI 직렬 호출이 근본 원인이라는 것을 확인하고, 이후 병렬화로 해결했습니다 (이슈 5 참조).  
  
---  
  
## 이슈 3 — GitHub Actions에서 외부 응답 처리 시 주의할 점  
  
Discord webhook 연동 과정에서 응답 처리 방식으로 인한 오류가 두 번 발생했습니다.  
  
>[!quote]
**Discord webhook payload란?**  
> Discord webhook은 특정 URL로 HTTP POST 요청을 보내면 지정된 채널에 메시지를 전송하는 방식입니다.  
> 요청 body에 담기는 JSON이 payload입니다.  
>  
> ```json  
> {  
>   "embeds": [  
>     {  
>       "title": "⚾ KIA 타이거즈",  
>       "description": "류현진, 시즌 첫 선발 등판...",  
>       "color": 16711680  
>     }  
>   ]  
> }  
> ```  
>  
> `content`(단순 텍스트)와 `embeds`(카드형 메시지) 두 가지 방식이 있으며, pitch-feed는 뉴스 요약을 카드 형태로 보여주기 위해 `embeds`를 사용합니다.  
> Discord는 payload가 유효한 JSON이 아니거나 특수문자가 깨지면 **error code 50109**를 반환합니다.  
  
### 3-1. invalid JSON (error code 50109)  
  
**증상**  
```json  
{"message": "The request body contains invalid JSON.", "code": 50109}  
```  
  
**원인**  
이슈 1(Render IP 차단) 해결 과정에서 Discord 호출을 Render에서 GitHub Actions로 이동했습니다. 이에 따라 Render 엔드포인트가 반환하는 값이 단순 문자열(`"Triggered"`)에서 Discord payload JSON으로 바뀌었는데, workflow의 step 간 데이터 전달 방식은 기존 `echo` 방식을 그대로 유지했습니다.  
  
`echo "key=value"` 방식은 단순 문자열에는 안전하지만, 한글·이모지(`⚾`, `📋`)가 포함된 JSON을 step outputs으로 넘기면 특수문자가 깨집니다.  
  
```yaml  
# 문제가 된 방식  
- name: Get payload  
  id: batch                                          # (1) 이 step의 식별자  
  run: echo "payload=$(curl $RENDER_URL)" >> $GITHUB_OUTPUT  #          ^^^^^^^ (2)  ^^^^^^^^^^^^^ (3)    ^^^^^^^^^^^^^^^ (4)  
- name: Send to Discord  
  run: |    curl -X POST $DISCORD_WEBHOOK \         -d '${{ steps.batch.outputs.payload }}'  # (5) 특수문자 깨짐  
```  
  
| 번호 | 설명 |  
|------|------|  
| (1) `id: batch` | 이 step을 다른 step에서 참조할 때 쓸 이름 |  
| (2) `echo "payload=..."` | `key=value` 형식으로 출력값을 선언. `payload`가 key |  
| (3) `$(curl $RENDER_URL)` | curl 실행 결과를 문자열로 치환해 value에 삽입 |  
| (4) `>> $GITHUB_OUTPUT` | GitHub Actions가 제공하는 특수 파일에 append. 여기 쓰인 값이 outputs으로 등록됨 |  
| (5) `steps.batch.outputs.payload` | `id`가 `batch`인 step의 `payload` output을 참조하는 표현식 |  
  
**해결 — payload를 파일로 저장 후 전송**  
  
```yaml  
- name: Get payload  
  run: curl -o /tmp/discord_payload.json $RENDER_URL  #          ^^ 응답 body를 파일로 저장 (-o: output)  
- name: Send to Discord  
  run: |    curl -X POST $DISCORD_WEBHOOK \  #      ^^^^^^ HTTP 메서드 지정  
         -H "Content-Type: application/json" \  #      ^^ 요청 헤더 추가 (-H: header)         -d @/tmp/discord_payload.json  #      ^^ 요청 body 지정 (-d: data). @를 붙이면 문자열이 아닌 파일에서 읽음  
```  
  
| 옵션 | 설명 |  
|------|------|  
| `-o <file>` | 응답 body를 파일로 저장. 미사용 시 stdout으로 출력됨 |  
| `-X POST` | HTTP 메서드 지정. 기본값은 GET |  
| `-H "key: value"` | 요청 헤더 추가 |  
| `-d <data>` | 요청 body 지정. 문자열을 직접 넘기거나 `@파일경로`로 파일 내용을 전송 |  
  
`echo` 방식은 단순 문자열에만 안전합니다. 한글·이모지가 포함된 JSON은 파일 경유가 표준입니다.  
  
### 3-2. jq parse error (exit code 5)  
  
**증상**  
```  
jq: parse error: Invalid numeric literal at EOF at line 1, column 9  
```  
  
**원인**  
`/tmp/discord_payload.json`에 유효한 JSON 대신 문자열(`"Triggered"`)이 담겨 있었습니다. Render 재배포 완료 전에 workflow를 실행해 구버전 코드가 응답한 것이 원인이었고, jq는 입력 전체가 유효한 JSON이어야 하므로 즉시 실패합니다.  

>[!quote]
>**jq란?**  
> jq는 JSON 데이터를 파싱·필터·변환하는 커맨드라인 툴입니다. JSON 구조를 탐색하거나 특정 필드를 추출할 때 강력하지만, 입력이 유효한 JSON이 아니면 즉시 오류를 냅니다.
>
> ```bash  
> # 특정 필드 추출  
> echo '{"name":"KIA","wins":10}' | jq '.name'   # "KIA"  
>  
> # 비JSON 입력 시  
> echo '"Triggered"' | jq .embeds                # parse error  
> ```  

  
**해결 — 유효성 확인은 `grep`으로**  
  
```yaml  
# Before — jq로 파싱 시도  
cat /tmp/discord_payload.json | jq .  
  
# After — 문자열 탐색으로 대체  
grep -q '"embeds"' /tmp/discord_payload.json || { echo "Invalid payload"; exit 1; }  
```  
  
파싱이나 추출이 필요 없다면 `grep` 문자열 탐색이 더 견고합니다.  
  
**정리**: 두 오류 모두 GitHub Actions에서 외부 서비스 응답을 다룰 때의 패턴에서 비롯됐습니다.  
  
| 상황 | 권장 방식 |  
|------|-----------|  
| 응답을 다음 step으로 전달 | `echo` → 파일(`-o /tmp/file.json`) |  
| 단순 유효성 확인 | `jq` → `grep -q` |  
| JSON 필드 추출·변환이 필요할 때 | `jq` 사용 (단, 응답이 항상 유효한 JSON임을 보장한 후) |  
  
---  
  
## 이슈 4 — `@WebMvcTest`에서 Spring Security 403 Forbidden  
  
**증상**  
`AuthControllerTest` 전체가 기대 상태코드(200/401) 대신 403 반환.  
  
세 가지 원인이 겹쳐 있었습니다.  
  
### 원인 1 — `@MockBean` deprecated (Spring Boot 3.4+)  
  
```java  
// Before  
import org.springframework.boot.test.mock.mockito.MockBean;  
@MockBean AuthService authService;  
  
// After  
import org.springframework.test.context.bean.override.mockito.MockitoBean;  
@MockitoBean AuthService authService;  
```  
  
### 원인 2 — `@WebMvcTest`가 `SecurityConfig`를 로드하지 않음  
  
`@WebMvcTest`는 웹 레이어 빈(`@Controller`, `Filter` 등)만 로드하는 슬라이스 테스트입니다. `SecurityConfig`는 자동 스캔 대상이 아니므로 Spring Boot 기본 보안(CSRF 활성화)이 적용되어 모든 POST 요청이 403이 됩니다.  
  
```java  
@WebMvcTest(AuthController.class)  
@Import(SecurityConfig.class)  // 실제 보안 설정 명시 로드  
class AuthControllerTest { ... }  
```  
  
> **`with(csrf())`를 쓰면 안 되는 이유**  
> `with(csrf())`로 작성하면 테스트는 통과하지만, 실제로는 CSRF가 꺼진 환경(JWT stateless)을 CSRF가 켜진 환경으로 테스트하는 모순이 생깁니다. `@Import(SecurityConfig.class)` 방식이 운영 환경과 일치하고, 보안 설정 변경 시 테스트가 실패하므로 회귀 탐지에도 유리합니다.  
  
> **JWT를 쓰면 CSRF가 필요 없는 이유**  
> CSRF 공격은 브라우저가 쿠키를 자동으로 첨부한다는 점을 이용합니다. JWT는 `Authorization: Bearer <token>` 헤더로 전송되는데, 브라우저는 Authorization 헤더를 절대 자동으로 붙이지 않습니다. 헤더는 JS 코드가 명시적으로 설정해야 하고, Same-Origin Policy에 의해 외부 도메인의 JS는 토큰 값을 읽을 수 없으므로 공격이 성립하지 않습니다.  
  
### 원인 3 — `JwtAuthenticationFilter` mock이 필터 체인을 끊음  
  
`@MockitoBean`으로 등록한 필터는 기본적으로 `chain.doFilter()`를 호출하지 않아 필터 체인이 끊깁니다.  
  
```java  
@MockitoBean JwtAuthenticationFilter jwtAuthenticationFilter;  
  
@BeforeEach  
void setUp() throws Exception {  
    doAnswer(inv -> {        ((FilterChain) inv.getArgument(2))            .doFilter(inv.getArgument(0), inv.getArgument(1));        return null;    }).when(jwtAuthenticationFilter).doFilter(any(), any(), any());  
}  
```  
  
---  
  
## 이슈 5 — AI 직렬 호출로 인한 배치 시간 초과  
  
**증상**  
이슈 2에서 `--max-time 360`으로 늘렸음에도 배치가 지속 실패.  
  
**원인**  
`RssFetchService`에서 기사별 AI 요약이 순차 실행됩니다.  
  
```  
피드 1개 × 기사 5건 × AI 응답 ~30초 = 총 ~150초  
(Render 콜드 스타트 ~100초 포함 시 ~250초+)  
```  
  
타임아웃을 아무리 늘려도 직렬 실행이 근본 원인이므로 한계가 있습니다.  
  
**해결 — `invokeAll()` + Virtual Thread로 병렬화**  
  
처리 흐름을 3단계로 분리했습니다.  
  
```java  
// 1단계: URL 중복 필터링 (DB 조회)  
List<RssItem> newItems = filterDuplicates(fetchedItems);  
  
// 2단계: AI 병렬 호출 (병목 구간)  
List<SummaryResult> results;  
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {  
    List<Callable<SummaryResult>> tasks = newItems.stream()        .map(item -> (Callable<SummaryResult>) () -> summaryService.summarize(item))        .toList();    results = executor.invokeAll(tasks).stream()        .map(f -> {            try { return f.get(); }            catch (Exception e) { throw new RuntimeException(e); }        })        .toList();}  
  
// 3단계: 순차 저장 (DB write는 순서 보장)  
results.forEach(articleRepository::save);  
```  
  
5건이 동시 실행되어 가장 느린 1건만 기다리면 됩니다. 총 AI 호출 시간이 `5 × 30초 → ~30초`로 줄었습니다.  
  
> **`invokeAll()`을 선택한 이유**  
> `invokeAll()`은 여러 Callable을 한 번에 제출하고 전부 완료될 때까지 블로킹 후 Future 리스트를 반환합니다. 코드가 단순하고 Virtual Thread 지정이 가능하며 추가 설정이 없어 이 케이스에 적합합니다.  
>  
> 
>| | CompletableFuture | invokeAll | parallelStream |  
> |---|---|---|---|  
> | 코드 복잡도 | 중간 | **낮음** | 매우 낮음 |  
> | Virtual Thread 지정 | 가능 | **가능** | 어려움 |  
> | I/O 병렬화 적합성 | 좋음 | **좋음** | 나쁨 |  
>  
> `parallelStream()`은 내부적으로 ForkJoinPool(CPU 코어 수 제한)을 사용하므로 AI 호출처럼 I/O 대기가 긴 작업에는 적합하지 않습니다.  
  
이 리팩터링 과정에서 `ArticleSummaryService` 내부 record였던 `SummaryResult`를 별도 클래스로 분리했습니다. 내부 record는 해당 클래스에서만 쓸 때 적합하지만, `RssFetchService`에서도 타입을 참조하게 되어 분리하는 것이 명확했습니다.  
  
---  
  
## 마치며  
  
| 이슈 | 핵심 교훈 |  
|------|-----------|  
| Render IP 차단 | 외부 서비스 호출은 IP를 통제할 수 있는 곳에서 담당하도록 분리 |  
| curl timeout | 타임아웃 수치를 올리기 전에 실제 소요 시간의 원인을 파악 |  
| GitHub Actions 응답 처리 | JSON은 파일 경유, 유효성 확인은 grep — jq는 추출·변환이 필요할 때만 |  
| WebMvcTest 403 | JWT 프로젝트는 `@Import(SecurityConfig.class)` + filter chain 위임 |  
| AI 직렬 호출 | I/O 바운드 작업은 Virtual Thread + `invokeAll()`로 병렬화 |