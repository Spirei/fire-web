# Deployment assets

The MIT license covers project code. This repository does not redistribute uploaded images, card art, film-derived artwork, sound effects, or other deployment media.

Deployers must provide assets they are authorized to use in their own uploads volume. Missing media must not be interpreted as a license to copy the original material. Local deployment assets must remain untracked and outside image build contexts.

Provide media under `public/uploads`, fonts under `public/fonts`, display icons under `public/icons`, illustration/card backgrounds under `public/images` and `public/share`, and an authorized map dataset at `public/maps-world.json` before building, or serve them separately. Uploads are mounted at runtime; build contexts exclude these directories. Without four-door art, the sidebar retains its ordinary navigation. Container data and upload mounts must be writable by UID/GID 1000; do not use world-writable permissions. Configure `FIRE_SETUP_TOKEN` privately for production initialization, and remove it after creating the administrator.
