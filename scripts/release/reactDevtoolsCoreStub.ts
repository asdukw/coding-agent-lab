function unavailable(): never {
	throw new Error("React DevTools are disabled in Coding Agent Lab releases.");
}

export default {
	initialize: unavailable,
	connectToDevTools: unavailable,
};
