import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { memo, useCallback, useState } from "react";

type ComposerProps = {
	isActive: boolean;
	isRunning: boolean;
	isVisible: boolean;
	onSubmit: (value: string) => void;
};

/**
 * Keeps the draft in a small, isolated subtree so every keystroke does not
 * re-render the transcript. The component stays mounted while dialogs own the
 * keyboard, which also preserves an unfinished draft.
 */
export const Composer = memo(function Composer({
	isActive,
	isRunning,
	isVisible,
	onSubmit,
}: ComposerProps) {
	const [draft, setDraft] = useState("");
	const submitDraft = useCallback(
		(value: string) => {
			if (!value.trim()) {
				return;
			}
			setDraft("");
			onSubmit(value);
		},
		[onSubmit],
	);

	if (!isVisible) {
		return null;
	}

	return (
		<Box
			borderStyle="round"
			borderColor={isRunning ? "yellow" : "cyan"}
			paddingX={1}
		>
			<Text color="green">{"> "}</Text>
			<TextInput
				focus={isActive}
				value={draft}
				onChange={setDraft}
				onSubmit={submitDraft}
				placeholder={
					isRunning
						? "Type while cagent works; Enter queues the message..."
						: "Type a message and press Enter..."
				}
			/>
		</Box>
	);
});
