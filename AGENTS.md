# AGENTS.md

Engineering conventions for `dsh-tokener`.

## Background

- DeepSeek Harness:
    - an open-source agent harness developed by DeepSeek AI.
    - Dive deep in to the code when you are preparing for development
    - Github: deepseek-ai/deepseek-harness
    - NPM: @deepseek-ai/dsh
    - Local git clone of [dsh](https://github.com/deepseek-ai/deepseek-harness):
        - may be found in the `~/dev/deepseek-harness` directory
        - `git pull` on the `main` branch to update
        - commits and tags are available for reference and comparison
        - run `pnpm install` to update dependencies after a `git pull` or switching commit/tag

- DeepSeek Harness Plugin:
    - docs:
        - Reference: https://deepseek-harness.github.io/deepseek-harness/en/reference/

- Tokener.dev:
  - A LLM provider at https://www.tokener.dev/
  - doc: https://www.tokener.dev/docs
  - LLM list: https://www.tokener.dev/models

## Coding
- Always consider the minimal change and the most performance efficient implementation.
- Try best to use the existing classes, utilities, styles, style tokens, events, presets and lifecycles provided by DeepSeek Harness.ess.
- Use English in code comments, documentation, Pull Request description, and commit messages.
- Smaller, less-coupling and modulized code and tests are preferred for better maintainability and testability.
- Avoid adding unnecessary code comments (unless for the pinned major decision or for those provide significant value) and code duplication.
- Before any commit, MUST ALWAYS do ALL the following checks:
    - Check the to-do list, and ensure all the items are properly completed or closed.
    - Carefully independently review and simplify all the diffs and all code changes, to ensure they are necessary, correct and not over-engineered.
    - Cleanup the generated temporary files. Cleanup temporary or unhelpful comments.
    - MUST Run `pnpm run lint:fix && pnpm run test && pnpm run build` in single command and capture FULL output, to ensure:
        - passing all the linting and test
        - the per-file code coverage MUST BE literally 100%.
            - Example output:
                - -------------------------|---------|----------|---------|---------|-------------------
                  File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
                  -------------------------|---------|----------|---------|---------|-------------------
                  All files                |     100 |      100 |     100 |     100 |
