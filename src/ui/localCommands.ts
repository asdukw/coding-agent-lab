export type LocalCommand = {
	type: "enter_plan_mode";
};

export function parseLocalCommand(input: string): LocalCommand | undefined {
	const trimmed = input.trim();

	if (trimmed === "/plan") {
		return { type: "enter_plan_mode" };
	}

	return undefined;
}
