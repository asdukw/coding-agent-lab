export function sanitizeFailureMessage(
	caught: unknown,
	options: {
		paths?: readonly string[];
		secrets?: readonly string[];
	} = {},
): string {
	let message = caught instanceof Error ? caught.message : String(caught);
	for (const path of options.paths ?? []) {
		for (const variant of sensitivePathVariants(path)) {
			message = replaceCaseInsensitive(message, variant, "<redacted-path>");
		}
	}
	for (const secret of options.secrets ?? []) {
		if (secret) {
			message = message.split(secret).join("<redacted-secret>");
		}
	}
	return message.replaceAll(/\s+/g, " ").trim().slice(0, 500);
}

export function containsSensitivePath(
	value: unknown,
	paths: readonly string[],
): boolean {
	const needles = paths
		.flatMap(sensitivePathVariants)
		.map(normalizePathText)
		.filter(Boolean);
	return objectStrings(value).some((entry) => {
		const normalized = normalizePathText(entry);
		return needles.some((needle) => normalized.includes(needle));
	});
}

export function containsSensitiveText(
	value: unknown,
	secrets: readonly string[],
): boolean {
	const needles = secrets.filter(Boolean);
	return objectStrings(value).some((entry) =>
		needles.some((needle) => entry.includes(needle)),
	);
}

function sensitivePathVariants(path: string): string[] {
	const normalized = path.replaceAll("\\", "/");
	return [
		path,
		normalized,
		`file:///${normalized.replace(/^\/+/, "")}`,
		encodeURI(normalized),
	];
}

function replaceCaseInsensitive(
	value: string,
	search: string,
	replacement: string,
): string {
	if (!search) {
		return value;
	}
	let result = value;
	for (;;) {
		const index = result.toLowerCase().indexOf(search.toLowerCase());
		if (index < 0) {
			return result;
		}
		result = `${result.slice(0, index)}${replacement}${result.slice(index + search.length)}`;
	}
}

function objectStrings(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(objectStrings);
	}
	if (value && typeof value === "object") {
		return Object.values(value).flatMap(objectStrings);
	}
	return [];
}

function normalizePathText(value: string): string {
	let decoded = value;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		// Invalid percent escapes remain literal and are still slash-normalized.
	}
	return decoded
		.replaceAll("\\", "/")
		.replaceAll(/\/{2,}/g, "/")
		.toLowerCase();
}
