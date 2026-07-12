# Contributing

Thank you for your interest in contributing!

## Issues and pull requests

If you have suggestions for improvements, you can contribute by opening an issue. If you'd like to introduce changes to the project, see the instructions below.

## Project structure

```
src/index.js       # Action source code
dist/*.index.js    # Compiled bundle and dynamic chunks used by the runner
action.yml         # Action metadata and input definitions
```

The action runs from `dist/index.js` and its generated chunks, built from `src/index.js` using [`@vercel/ncc`](https://github.com/vercel/ncc).

## Development setup

**Prerequisites:** Node.js 20+

```bash
git clone https://github.com/L-K-M/zai-code-review.git
cd zai-code-review
npm install
```

## Making changes

Edit `src/index.js`, then rebuild the bundle:

```bash
npm run build
```

**The `dist/` directory must be committed.** The GitHub Actions runner executes `dist/index.js` directly — it does not run `npm install` or build steps.

## Submitting a pull request

1. Fork the repository and create a branch from `main`
2. Make your changes in `src/index.js`
3. Run `npm run build` and commit both `src/` and `dist/` changes
4. Open a pull request against `main`

Please keep PRs focused — one fix or feature per PR.

## Releases

Releases use semantic versioning. A release commit updates `package.json`, `package-lock.json`,
`CHANGELOG.md`, and the committed `dist/` bundle. After CI succeeds on `main`, the release
workflow creates the matching tag and GitHub release automatically.

Users reference the action by tag in their workflows, so the `dist/index.js` and `action.yml` at the tagged commit are what gets executed.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
