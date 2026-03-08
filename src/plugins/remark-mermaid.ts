import { visit } from "unist-util-visit";

export function remarkMermaid() {
	return (tree: any) => {
		visit(tree, "code", (node, index, parent) => {
			if (node.lang !== "mermaid") return;
			parent.children.splice(index, 1, {
				type: "html",
				value: `<div class="mermaid">${node.value}</div>`,
			});
		});
	};
}
