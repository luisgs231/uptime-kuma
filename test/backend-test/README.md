# Node.js Test Runner

Documentation: https://nodejs.org/api/test.html

Create a test file in this directory named `test-*.js` — that is the shape
`extra/run-tests.mjs` collects, so a file named anything else is silently never
run. Helpers and mocks are deliberately outside it.

A file that starts a Docker service container is left out of the default run,
recognised by its `testcontainers` import. Nothing has to be registered for that
to happen, and nothing has to be registered to opt back in.

`test-domain.js` is excluded by name instead, because it asserts against a real
domain's real expiry date fetched over RDAP. Keep tests deterministic and this
list stays at one; assert against somebody else's live data and it grows.

> [!TIP]
> Writing great tests is hard.
>
> You can make our live much simpler by following this guidance:
>
> - Use `describe()` to group related tests
> - Use `test()` for individual test cases
> - One test per scenario
> - Use descriptive test names: `function() [behavior] [condition]`
> - Don't prefix with "Test" or "Should"

## Template

```js
const { describe, test } = require("node:test");
const assert = require("node:assert");

describe("Feature Name", () => {
  test("function() returns expected value when condition is met", () => {
    assert.strictEqual(1, 1);
  });
});
```

## Run

```bash
npm run test-both      # both databases, skipping the Docker-backed files
npm run test-backend   # everything, the Docker-backed files included
```
