.PHONY: release bump-patch bump-minor bump-major version delete-tag

# coport's version is the release version (the repo's own package.json stays 0.0.1).
# The release-coport.yml workflow fires on a `vX.Y.Z` tag and refuses to build
# unless the tag matches coport/package.json, so keep them in lockstep here.
VERSION := $(shell grep -m1 '"version"' coport/package.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

version:
	@echo $(VERSION)

# Cut a release: bump coport/package.json to $(TO), commit, and tag v$(TO).
# Usage: make release TO=1.4.0
release:
	@test -n "$(TO)" || { echo "usage: make release TO=X.Y.Z"; exit 1; }
	@echo "$(TO)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "invalid version '$(TO)' (expected X.Y.Z, with no leading 'v')"; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "working tree is dirty; commit or stash first"; exit 1; }
	@git rev-parse -q --verify "refs/tags/v$(TO)" >/dev/null && { echo "tag v$(TO) already exists"; exit 1; } || true
	@grep -q "^## \[$(TO)\]" CHANGELOG.md || { echo "CHANGELOG.md has no '## [$(TO)]' entry; the release workflow extracts notes from it. Add one first."; exit 1; }
	@if [ "$(TO)" = "$(VERSION)" ]; then \
		echo "coport/package.json is already at $(TO); will re-tag the current commit without bumping."; \
	fi
	@if [ -z "$(YES)" ]; then \
		if [ "$(TO)" = "$(VERSION)" ]; then \
			printf "re-tag v$(TO) on the current commit (no version bump)? [y/N] "; \
		else \
			printf "release v$(TO) (current: v$(VERSION))? [y/N] "; \
		fi; \
		read ans; \
		case "$$ans" in [yY]|[yY][eE][sS]) ;; *) echo "aborted"; exit 1;; esac; \
	fi
	@if [ "$(TO)" != "$(VERSION)" ]; then \
		sed -i '' 's/^\(  "version": \)"[^"]*"/\1"$(TO)"/' coport/package.json; \
		bun install >/dev/null; \
		git add coport/package.json bun.lock; \
		git commit -m "chore: release v$(TO)"; \
	fi
	git tag -a "v$(TO)" -m "v$(TO)"
	@echo "tagged v$(TO) — run 'git push --follow-tags' to publish (the Release coport workflow drafts the GitHub release)"

# Delete a tag locally (and on origin if it exists there).
# Usage: make delete-tag TAG=v1.4.0
delete-tag:
	@test -n "$(TAG)" || { echo "usage: make delete-tag TAG=vX.Y.Z"; exit 1; }
	@git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "tag $(TAG) does not exist locally"; exit 1; }
	@if command -v gh >/dev/null 2>&1 && gh release view "$(TAG)" >/dev/null 2>&1; then \
		echo "a GitHub release points to $(TAG); delete it first with 'gh release delete $(TAG)'"; exit 1; \
	fi
	@if [ -z "$(YES)" ]; then \
		printf "delete tag $(TAG) locally and on origin? [y/N] "; \
		read ans; \
		case "$$ans" in [yY]|[yY][eE][sS]) ;; *) echo "aborted"; exit 1;; esac; \
	fi
	git tag -d "$(TAG)"
	@git push origin ":refs/tags/$(TAG)" 2>/dev/null || echo "(tag not on origin, or push skipped)"

# Convenience wrappers that compute the next version from the current one.
bump-patch:
	@$(MAKE) release TO=$(shell echo $(VERSION) | awk -F. '{printf "%d.%d.%d", $$1, $$2, $$3+1}')

bump-minor:
	@$(MAKE) release TO=$(shell echo $(VERSION) | awk -F. '{printf "%d.%d.0", $$1, $$2+1}')

bump-major:
	@$(MAKE) release TO=$(shell echo $(VERSION) | awk -F. '{printf "%d.0.0", $$1+1}')
