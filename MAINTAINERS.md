# Maintainers

| Name             | GitHub                                       | Area           |
| ---------------- | -------------------------------------------- | -------------- |
| Renaud Pelissier | [@rpelissier](https://github.com/rpelissier) | the whole tree |

A maintainer reviews and merges pull requests, cuts releases, triages issues and handles
vulnerability reports ([SECURITY.md](SECURITY.md)). `.github/CODEOWNERS` requests a maintainer's
review on every pull request.

## How decisions are taken

- **What the product does** is the specification under [`docs/spec/`](docs/spec/). A change to it
  is proposed in an issue and agreed there before any code.
- **How it is built**: a structural choice is written as an ADR under
  [`docs/decisions/`](docs/decisions/) (Context, Decision, Consequences, Rejected alternatives),
  in the pull request that makes the choice. A decision that changes later is rewritten in place,
  with a dated line in its `## History`.
- Anyone can propose a decision in an issue or a pull request. While the project has one
  maintainer, that maintainer decides; with several, a decision needs the agreement of the
  maintainers who take part in the discussion, and any one of them can ask for more time.

## How a maintainer is added

A contributor with a record of reviewed and merged pull requests can be proposed by any maintainer,
or can ask. The current maintainers agree, and the change is a pull request that adds the person to
this file and to `.github/CODEOWNERS`. A maintainer who steps down is moved out the same way.

## How the code is written

Most commits are co-authored with AI coding agents (the `Co-Authored-By:` trailer says which), under
the maintainer's review: a person reads and approves every change before it is merged, and is
accountable for it. The rules the agents follow are the ones a human contributor follows
([CONTRIBUTING.md](CONTRIBUTING.md), [docs/AGENTS-guide.md](docs/AGENTS-guide.md)).
