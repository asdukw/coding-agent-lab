import { Box, Text } from "ink";
import type { ReactNode } from "react";

type InlinePart =
	| { type: "text"; text: string }
	| { type: "code"; text: string }
	| { type: "strong"; text: string }
	| { type: "em"; text: string }
	| { type: "link"; text: string; href: string };

type Block =
	| { type: "blank" }
	| { type: "blockquote"; text: string }
	| { type: "code"; text: string; lang?: string }
	| { type: "heading"; depth: number; text: string }
	| { type: "list"; ordered: boolean; marker: string; text: string }
	| { type: "paragraph"; text: string }
	| { type: "rule" }
	| { type: "table"; rows: string[][] };

type MarkdownProps = {
	children: string;
};

export function Markdown({ children }: MarkdownProps) {
	const blocks = parseBlocks(children);

	return (
		<Box flexDirection="column">
			{blocks.map((block, index) => (
				<MarkdownBlock block={block} key={blockKey(block, index)} />
			))}
		</Box>
	);
}

function MarkdownBlock({ block }: { block: Block }) {
	switch (block.type) {
		case "blank":
			return <Text> </Text>;
		case "blockquote":
			return (
				<Text color="gray" italic>
					| {renderInline(block.text)}
				</Text>
			);
		case "code":
			return (
				<Box flexDirection="column" paddingLeft={1}>
					{block.lang ? <Text color="gray">{block.lang}</Text> : null}
					<Text color="gray">{block.text || " "}</Text>
				</Box>
			);
		case "heading":
			return (
				<Text
					bold
					color={block.depth <= 2 ? "cyan" : undefined}
					underline={block.depth === 1}
				>
					{renderInline(block.text)}
				</Text>
			);
		case "list":
			return (
				<Text>
					{block.marker} {renderInline(block.text)}
				</Text>
			);
		case "paragraph":
			return <Text>{renderInline(block.text)}</Text>;
		case "rule":
			return <Text color="gray">---</Text>;
		case "table":
			return (
				<Box flexDirection="column">
					{block.rows.map((row, index) => (
						<Text key={rowKey(row, index)}>{row.join("  ")}</Text>
					))}
				</Box>
			);
	}
}

function parseBlocks(markdown: string): Block[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();

		if (!trimmed) {
			blocks.push({ type: "blank" });
			index++;
			continue;
		}

		const fenceMatch = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
		if (fenceMatch) {
			const codeLines: string[] = [];
			index++;
			while (index < lines.length && !lines[index]?.trim().startsWith("```")) {
				codeLines.push(lines[index] ?? "");
				index++;
			}
			if (index < lines.length) {
				index++;
			}
			blocks.push({
				type: "code",
				lang: fenceMatch[1],
				text: codeLines.join("\n"),
			});
			continue;
		}

		const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch?.[1] && headingMatch[2]) {
			blocks.push({
				type: "heading",
				depth: headingMatch[1].length,
				text: headingMatch[2],
			});
			index++;
			continue;
		}

		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			blocks.push({ type: "rule" });
			index++;
			continue;
		}

		const quoteMatch = trimmed.match(/^>\s?(.*)$/);
		if (quoteMatch) {
			blocks.push({ type: "blockquote", text: quoteMatch[1] ?? "" });
			index++;
			continue;
		}

		const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
		if (unorderedMatch?.[1] !== undefined && unorderedMatch[2]) {
			blocks.push({
				type: "list",
				ordered: false,
				marker: `${" ".repeat(Math.floor(unorderedMatch[1].length / 2) * 2)}-`,
				text: unorderedMatch[2],
			});
			index++;
			continue;
		}

		const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
		if (orderedMatch?.[1] !== undefined && orderedMatch[2] && orderedMatch[3]) {
			blocks.push({
				type: "list",
				ordered: true,
				marker: `${" ".repeat(Math.floor(orderedMatch[1].length / 2) * 2)}${orderedMatch[2]}.`,
				text: orderedMatch[3],
			});
			index++;
			continue;
		}

		if (isTableStart(lines, index)) {
			const rows: string[][] = [];
			while (index < lines.length && lines[index]?.includes("|")) {
				const current = lines[index] ?? "";
				if (!isTableDivider(current)) {
					rows.push(parseTableRow(current));
				}
				index++;
			}
			blocks.push({ type: "table", rows });
			continue;
		}

		const paragraphLines = [trimmed];
		index++;
		while (
			index < lines.length &&
			shouldContinueParagraph(lines[index] ?? "")
		) {
			paragraphLines.push((lines[index] ?? "").trim());
			index++;
		}
		blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
	}

	return trimOuterBlankBlocks(blocks);
}

function shouldContinueParagraph(line: string): boolean {
	const trimmed = line.trim();

	return (
		Boolean(trimmed) &&
		!trimmed.startsWith("```") &&
		!trimmed.startsWith(">") &&
		!trimmed.startsWith("#") &&
		!/^(\s*)[-*+]\s+/.test(line) &&
		!/^(\s*)\d+\.\s+/.test(line) &&
		!/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
	);
}

function isTableStart(lines: string[], index: number): boolean {
	const current = lines[index] ?? "";
	const next = lines[index + 1] ?? "";

	return current.includes("|") && isTableDivider(next);
}

function isTableDivider(line: string): boolean {
	return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function trimOuterBlankBlocks(blocks: Block[]): Block[] {
	let start = 0;
	let end = blocks.length;

	while (blocks[start]?.type === "blank") {
		start++;
	}
	while (blocks[end - 1]?.type === "blank") {
		end--;
	}

	return blocks.slice(start, end);
}

function renderInline(text: string): ReactNode {
	return parseInline(text).map((part, index) => {
		switch (part.type) {
			case "code":
				return (
					<Text color="yellow" key={inlineKey(part, index)}>
						{part.text}
					</Text>
				);
			case "strong":
				return (
					<Text bold key={inlineKey(part, index)}>
						{renderInline(part.text)}
					</Text>
				);
			case "em":
				return (
					<Text italic key={inlineKey(part, index)}>
						{renderInline(part.text)}
					</Text>
				);
			case "link":
				return (
					<Text color="cyan" underline key={inlineKey(part, index)}>
						{part.text || part.href}
					</Text>
				);
			case "text":
				return part.text;
		}

		return null;
	});
}

function parseInline(text: string): InlinePart[] {
	const parts: InlinePart[] = [];
	let rest = text;

	while (rest) {
		const match = rest.match(
			/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/,
		);
		if (!match?.index && match?.index !== 0) {
			parts.push({ type: "text", text: rest });
			break;
		}

		if (match.index > 0) {
			parts.push({ type: "text", text: rest.slice(0, match.index) });
		}

		const token = match[0];
		if (token.startsWith("`")) {
			parts.push({ type: "code", text: token.slice(1, -1) });
		} else if (token.startsWith("**") || token.startsWith("__")) {
			parts.push({ type: "strong", text: token.slice(2, -2) });
		} else if (token.startsWith("[") && token.includes("](")) {
			const separator = token.indexOf("](");
			parts.push({
				type: "link",
				text: token.slice(1, separator),
				href: token.slice(separator + 2, -1),
			});
		} else {
			parts.push({ type: "em", text: token.slice(1, -1) });
		}

		rest = rest.slice((match.index ?? 0) + token.length);
	}

	return parts;
}

function blockKey(block: Block, index: number): string {
	switch (block.type) {
		case "blank":
			return `blank-${index}`;
		case "code":
			return `code-${index}-${block.lang ?? ""}-${block.text.slice(0, 32)}`;
		case "heading":
			return `heading-${index}-${block.depth}-${block.text}`;
		case "list":
			return `list-${index}-${block.marker}-${block.text}`;
		case "paragraph":
		case "blockquote":
			return `${block.type}-${index}-${block.text.slice(0, 48)}`;
		case "rule":
			return `rule-${index}`;
		case "table":
			return `table-${index}-${block.rows.length}`;
	}
}

function rowKey(row: string[], index: number): string {
	return `row-${index}-${row.join("|")}`;
}

function inlineKey(part: InlinePart, index: number): string {
	switch (part.type) {
		case "link":
			return `${part.type}-${index}-${part.text}-${part.href}`;
		default:
			return `${part.type}-${index}-${part.text}`;
	}
}
