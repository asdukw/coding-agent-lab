import { Box, Text, useInput } from "ink";

export type SelectionMenuOption<TValue extends string> = {
	value: TValue;
	label: string;
	description?: string;
	tone?: "default" | "danger";
};

export type SelectionMenuProps<TValue extends string> = {
	options: readonly SelectionMenuOption<TValue>[];
	selectedIndex: number;
	onSelectionChange(index: number): void;
	onConfirm(value: TValue): void;
	onCancel?: () => void;
	isActive?: boolean;
	footer?: string;
};

export function SelectionMenu<TValue extends string>({
	options,
	selectedIndex,
	onSelectionChange,
	onConfirm,
	onCancel,
	isActive = true,
	footer,
}: SelectionMenuProps<TValue>) {
	const normalizedIndex = normalizeSelection(selectedIndex, options.length);

	useInput(
		(input, key) => {
			if (options.length === 0) {
				return;
			}
			if (key.upArrow) {
				onSelectionChange(
					(normalizedIndex - 1 + options.length) % options.length,
				);
				return;
			}
			if (key.downArrow) {
				onSelectionChange((normalizedIndex + 1) % options.length);
				return;
			}
			if (key.escape) {
				onCancel?.();
				return;
			}

			const directIndex = directSelectionIndex(input, options.length);
			if (directIndex !== undefined) {
				const option = options[directIndex];
				if (option) {
					onSelectionChange(directIndex);
					onConfirm(option.value);
				}
				return;
			}
			if (key.return) {
				const option = options[normalizedIndex];
				if (option) {
					onConfirm(option.value);
				}
			}
		},
		{ isActive },
	);

	return (
		<Box flexDirection="column" marginTop={1}>
			{options.map((option, index) => {
				const selected = normalizedIndex === index;
				return (
					<Box flexDirection="column" key={option.value}>
						<Text
							bold={selected}
							color={
								selected ? "cyan" : option.tone === "danger" ? "red" : "white"
							}
						>
							{selected ? "›" : " "} {index + 1}. {option.label}
						</Text>
						{option.description ? (
							<Text color="gray"> {option.description}</Text>
						) : null}
					</Box>
				);
			})}
			<Text color="gray">
				{footer ??
					`Use ↑/↓ and Enter, press 1-${options.length}, or Esc to cancel.`}
			</Text>
		</Box>
	);
}

function normalizeSelection(
	selectedIndex: number,
	optionCount: number,
): number {
	if (optionCount === 0 || selectedIndex < 0 || selectedIndex >= optionCount) {
		return 0;
	}
	return selectedIndex;
}

function directSelectionIndex(
	input: string,
	optionCount: number,
): number | undefined {
	if (!/^\d$/.test(input)) {
		return undefined;
	}
	const index = Number(input) - 1;
	return index >= 0 && index < optionCount ? index : undefined;
}
