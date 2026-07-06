# coding-agent-learn

To install dependencies:

```bash
bun install
```

Configure DeepSeek:

```bash
cp .env.example .env
```

Set `DEEPSEEK_API_KEY` in `.env`. Optional overrides:

```bash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

To run:

```bash
bun run start
```

To verify DeepSeek connectivity:

```bash
bun run test:deepseek
```

The connectivity test is skipped when `DEEPSEEK_API_KEY` is not set.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
