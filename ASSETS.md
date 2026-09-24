# Deployment assets

The MIT license covers project code. This repository does not redistribute uploaded images, card art, film-derived artwork, sound effects, or other deployment media.

Deployers must provide assets they are authorized to use in their own uploads volume. Missing media must not be interpreted as a license to copy the original material. Local deployment assets must remain untracked and outside image build contexts.

Provide media under `public/uploads`, fonts under `public/fonts`, display icons under `public/icons`, and illustration/card backgrounds under `public/images` and `public/share`. Uploads are mounted at runtime; build contexts exclude these directories, so they can never be baked in by copying the source tree.

Runtime wiring: `docker-compose.ghcr.yml` mounts the host directories `${IMAGES_DIR:-./images}`, `${FONTS_DIR:-./fonts}`, `${ICONS_DIR:-./icons}` and `${SHARE_DIR:-./share}` read-only onto `/app/public/{images,fonts,icons,share}`, next to the uploads mount. Putting the files there is the supported way to supply them; an empty or missing mount degrades to 404 for those URLs without affecting startup (the entrypoint logs `缺少部署素材` in that case). Missing `public/images/fire/clownfish-family.png` is why the FIRE page's clownfish pair can look like it vanished — see `docs/synology-deploy.md` section 1d and its troubleshooting entry.

Exception: the four files the four-door sidebar switcher needs to render — `public/uploads/feature/four-door/{window,dial,pointer,cursor-hand}.png` — are tracked in this repository and baked into the image (they land in `/app/resource-default` and are seeded into the uploads volume on first start by `scripts/entrypoint.sh`). They stay tiny, and without them the sidebar entry flashes and then disappears. Every other upload/font/illustration asset remains deployer-supplied and untracked.

Container data and upload mounts must be writable by UID/GID 1000; do not use world-writable permissions. Configure `FIRE_SETUP_TOKEN` privately for production initialization, and remove it after creating the administrator.
