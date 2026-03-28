---
title: Oracle Cloud Free Tier 인스턴스 생성 가이드
description: kbo 룰봇 oci에 올리기
pubDatetime: 2026-03-29T10:00:00+09:00
tags:
  - RAG
  - OCI
  - bb-rules-bot
---
> Oracle Cloud Infrastructure(OCI) Free Tier에서 Ubuntu 서버 인스턴스를 생성하는 전체 과정을 정리합니다.  
  
---  
  
## 사전 준비: VCN 생성  
  
인스턴스 생성 전에 VCN을 먼저 만들어야 합니다. 인스턴스 생성 과정 중 Networking 단계에서 VCN과 Subnet을 선택해야 하는데, 미리 만들어두지 않으면 진행이 막힙니다.  
  
### VCN이 뭔가요?  
VCN(Virtual Cloud Network)은 OCI에서 제공하는 가상 네트워크입니다. 인스턴스가 인터넷과 통신하려면 반드시 VCN에 속해야 합니다. AWS의 VPC와 동일한 개념입니다.  
  
VCN은 다음 구성 요소로 이루어집니다:  
  
| 구성 요소            | 역할                 |
| ---------------- | ------------------ |
| Subnet           | 인스턴스가 속하는 네트워크 대역  |
| Internet Gateway | VCN과 인터넷을 연결하는 관문  |
| Route Table      | 트래픽이 어디로 가야 하는지 정의 |
| Security List    | 인바운드/아웃바운드 트래픽 규칙  |
  
### 1) VCN 생성  
- Networking → Virtual Cloud Networks → **Create VCN**  
- Name: 원하는 이름 입력  
- IPv4 CIDR Block: `10.0.0.0/16`  
- DNS Hostnames 활성화 (IP 대신 호스트명으로 접속 가능)  
- DNS Label: 기본값  
- Create 클릭  
  
### 2) Public Subnet 생성  
- 생성된 VCN 상세 → Subnets → **Create Subnet**  
- Name: `public-subnet`  
- Subnet Type: Regional  
- IPv4 CIDR Block: `10.0.0.0/24`  
- Subnet Access: **Public Subnet** 선택  
- Route Table: Default Route Table  
- Create 클릭  
  
> Public Subnet이어야 하는 이유: Public Subnet에 속한 인스턴스만 공인 IP를 할당받을 수 있습니다. 공인 IP가 없으면 외부에서 SSH 접속과 API 호출이 불가능합니다.  
  
### 3) Internet Gateway 생성  
- VCN 상세 좌측 메뉴 → Internet Gateways → **Create Internet Gateway**  
- Name: 원하는 이름 입력  
- Create 클릭  
  
> Internet Gateway가 없으면 인스턴스가 인터넷과 통신할 수 없어 SSH 접속이 불가능합니다.  
  
### 4) Route Table에 Internet Gateway 연결  
- VCN 상세 → Route Tables → **Default Route Table** 클릭  
- **Add Route Rules** 클릭  
- Target Type: `Internet Gateway`  
- Destination CIDR: `0.0.0.0/0`  
- Target: 3번에서 만든 Internet Gateway 선택  
- Add 클릭  
  
---  
  
## 인스턴스 생성  
  
Networking → Compute → Instances → **Create Instance**  
  
---  
  
### Step 1. Image 선택  
  
#### 이게 뭔가요?  
인스턴스에 설치할 운영체제입니다.  
  
#### 왜 Ubuntu 22.04인가요?  
- LTS(Long Term Support) 버전으로 안정적  
- Docker, Java 등 주요 패키지 지원이 풍부  
- `jammy`(22.04 코드명)는 Docker 공식 이미지와 호환성이 좋음  
  
#### 어떻게 하나요?  
- **Change image** → Canonical Ubuntu → `22.04` 선택  
  
---  
  
### Step 2. Shape 선택  
  
#### 이게 뭔가요?  
Shape은 인스턴스의 CPU, 메모리 사양을 결정합니다. OCI Free Tier에서는 두 가지 Always Free Shape이 있습니다.  
  
| Shape | CPU | RAM | 비고 |  
|-------|-----|-----|------|  
| VM.Standard.A1.Flex | ARM 최대 4 OCPU | 최대 24GB | 리전 재고 부족 시 생성 불가 |  
| VM.Standard.E2.1.Micro | AMD 1 OCPU | 1GB | 항상 사용 가능 |  
  
#### 어떻게 하나요?  
- **Change shape** → Ampere(A1) 또는 VM.Standard.E2.1.Micro 선택  
  
> **주의**: A1은 리전에 따라 재고가 없을 수 있습니다. 한국(춘천) 리전은 A1 재고가 부족한 경우가 많으며 Free Tier는 리전 변경이 불가합니다. A1을 선택할 수 없는 경우 E2.1.Micro로 대체하세요. 단, RAM이 1GB뿐이라 JVM 메모리 옵션 조정이 필요합니다.  
  
---  
  
### Step 3. Security  
  
#### 이게 뭔가요?  
인스턴스 메타데이터 서비스(IMDS, Instance Metadata Service)에 대한 접근 보안을 설정하는 단계입니다. IMDS는 인스턴스 내부에서 자신의 IP, 리전, SSH 키 등 인스턴스 정보를 조회할 수 있는 OCI 내부 API입니다.  
  
핵심 설정은 **Management Authorization Header**입니다:  
  
| 설정값 | 동작 |  
|--------|------|  
| Disabled | 인스턴스 내부에서 누구나 IMDS 조회 가능 |  
| Enabled | IMDS 조회 시 Authorization 헤더 필수 (인증된 요청만 허용) |  
  
#### 왜 지금은 설정하지 않아도 되나요?  
IMDS는 인스턴스 **내부**에서만 접근 가능한 서비스입니다. 외부에서 직접 접근할 수 없기 때문에 단순한 개인 프로젝트 수준에서는 기본값(Disabled)으로 두어도 무방합니다.  
  
#### 활성화하면 뭐가 다른가요?  
Enabled로 설정하면 IMDS를 조회할 때 요청 헤더에 Authorization 토큰을 포함해야 합니다. 인스턴스 내부에서 실행되는 코드가 OCI SDK나 CLI로 인스턴스 정보를 조회하는 경우 추가 인증 처리가 필요해집니다. SSRF(Server-Side Request Forgery) 공격 방어에 효과적입니다.  
  
#### 활성화를 고려해야 하는 경우  
- 인스턴스에서 OCI SDK/CLI를 사용해 다른 OCI 서비스에 접근하는 경우  
- 보안 요구사항이 높은 프로덕션 환경  
  
활성화 시 참고: [OCI 공식 문서 - IMDSv2](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/gettingmetadata.htm)  
  
#### 어떻게 하나요?  
기본값 그대로 두고 넘어갑니다.  
- Management Authorization Header: Disabled (기본값)  
  
---  
  
### Step 4. Networking — VNIC 설정  
  
#### VNIC이 뭔가요?  
VNIC(Virtual Network Interface Card)은 인스턴스가 네트워크에 연결되는 가상 네트워크 카드입니다. 물리 서버의 랜카드와 동일한 개념입니다. 인스턴스는 반드시 하나 이상의 VNIC을 가져야 하며, 이 VNIC이 VCN의 Subnet에 연결되어 IP를 할당받습니다.  
  
| 항목 | 설명 |  
|------|------|  
| Primary VNIC | 인스턴스의 기본 네트워크 카드 |  
| VCN | VNIC이 속할 가상 네트워크 |  
| Subnet | VNIC이 속할 서브넷. **Public Subnet 선택 필수** |  
| Private IPv4 | VCN 내부에서 사용하는 사설 IP (자동 할당) |  
| Public IPv4 | 외부에서 접근 가능한 공인 IP (자동 할당) |  
  
#### 어떻게 하나요?  
- **Select existing virtual cloud network** → 사전 준비에서 만든 VCN 선택  
- **Select existing subnet** → `public-subnet` 선택  
- **Public IPv4 address** → Automatically assign 선택  
  
> **주의**: Public IPv4 자동 할당이 비활성화되어 있다면 Private Subnet이 선택된 것입니다. Public Subnet으로 변경하세요.  
  
---  
  
### Step 5. SSH 키 설정  
  
#### 이게 뭔가요?  
SSH 키는 서버에 접속할 때 사용하는 인증 수단입니다. 비밀번호 대신 키 파일로 접속합니다. 공개키(Public Key)는 서버에 등록되고, 프라이빗 키(Private Key)는 본인이 보관합니다.  
  
#### 어떻게 하나요?  
- **Generate a key pair for me** 선택  
- **Save Private Key** 클릭해서 `.key` 파일 다운로드  
  
> **중요**: 프라이빗 키 파일은 재발급이 불가능합니다. 반드시 안전한 곳에 보관하세요.  
  
---  
  
### Step 6. Boot Volume  
  
#### 이게 뭔가요?  
인스턴스의 OS가 설치되는 디스크입니다. Free Tier에서는 최대 200GB까지 무료입니다.  
  
#### 어떻게 하나요?  
기본값 그대로 두고 Create 클릭합니다.  
- Use in-transit encryption: 활성화 (기본값)  
- 나머지: 비활성화 (기본값)  
  
> 콘솔에서 예상 비용($2.76/month)이 표시될 수 있지만, Free Tier 범위 내에서는 실제 청구되지 않습니다.  
  
---  
  
## 인스턴스 생성 후  
  
### 공인 IP 확인  
인스턴스 상세 페이지 → **Public IP address** 확인  
  
### Security List에서 포트 오픈  
기본적으로 SSH(22번)만 열려 있습니다. 애플리케이션 포트를 추가해야 합니다.  
  
- 인스턴스 상세 → Attached VNICs → Subnet → Security Lists → Default Security List → **Add Ingress Rules**  
  
| 항목 | 값 |  
|------|-----|  
| Source CIDR | `0.0.0.0/0` |  
| IP Protocol | TCP |  
| Source Port Range | All |  
| Destination Port Range | `8080` |  
  
### SSH 접속  
```bash  
chmod 400 ~/Downloads/ssh-key-xxxx.keyssh -i ~/Downloads/ssh-key-xxxx.key ubuntu@<공인 IP>  
# 접속 성공 시 프롬프트  
ubuntu@<인스턴스명>:~$  
```  
  
> SSH 접속이 안 될 경우 체크리스트:  
> 1. Security List에 22번 포트 인바운드 규칙이 있는지 확인  
> 2. Route Table에 `0.0.0.0/0 → Internet Gateway` 규칙이 있는지 확인  
> 3. 키 파일 권한이 400인지 확인 (`chmod 400 <키 파일>`)  
> 4. 터미널에서 `ssh -v` 옵션으로 어디서 막히는지 확인