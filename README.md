# dsh-tokener

[![npm](https://img.shields.io/npm/v/dsh-tokener)](https://www.npmjs.com/package/dsh-tokener)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that adds [Tokener.dev](https://www.tokener.dev) as a ready-to-configure LLM provider.

## Install

```sh
dsh plugin --profile add dsh-tokener
```

## Configuration

- Then open **Settings → Models**. A `Tokener` row is already listed: enter your API key and save. The key is stored in the harness credential store under `TOKENER_API_KEY`; exporting that variable in the launching environment works too.

![settings](https://raw.githubusercontent.com/bowenliang123/dsh-tokener/main/docs/images/settigns.png)

## License

[Apache-2.0](./LICENSE)
