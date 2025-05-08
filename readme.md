# ts-template-pnpm

## Usage

`pnpm run setup`

The script source is at ./setup.js and will move `workflows` into `.github/workflows` and then install the devDeps.

### Add NPM_TOKEN to github secrets

For the publish workflow to work, you need to add your NPM token as a secret to the repository.

### Enable Github Pages for Docs

`Repo Settings > Pages > Build and deployment > Github Actions`

This will let the pages workflow complete.

> Done!
