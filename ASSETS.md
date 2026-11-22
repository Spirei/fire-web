# Deployment assets

The MIT license covers project code. Except for the runtime illustrations listed below, this repository does not redistribute uploaded images, card art, film-derived artwork, sound effects, or other deployment media.

Deployers must provide assets they are authorized to use in their own uploads volume. Missing media must not be interpreted as a license to copy the original material. Deployment-specific assets must remain untracked and outside image build contexts.

Provide media under `public/uploads`, fonts under `public/fonts`, display icons under `public/icons`, and illustration/card backgrounds under `public/images` and `public/share`. Uploads are mounted at runtime; build contexts exclude these directories, so they can never be baked in by copying the source tree.

Runtime wiring: `docker-compose.ghcr.yml` mounts the host directories `${IMAGES_DIR:-./images}`, `${FONTS_DIR:-./fonts}`, `${ICONS_DIR:-./icons}` and `${SHARE_DIR:-./share}` read-only onto `/app/public/{images,fonts,icons,share}`, next to the uploads mount. Putting deployment-specific files there is the supported way to supply them; an empty or missing mount degrades to 404 for those URLs without affecting startup (the entrypoint logs `缺少部署素材` in that case).

The FIRE runtime illustration is an explicit exception: `public/fire-assets/clownfish-family.png` is included in the repository and image, outside the mounted `images` directory. The build checks that it exists. It remains display artwork, separate from the MIT-licensed code. Older images use `/images/fire/clownfish-family.png` and need that file in their runtime images mount until upgraded.


Container data and upload mounts must be writable by UID/GID 1000; do not use world-writable permissions. Configure `FIRE_SETUP_TOKEN` privately for production initialization, and remove it after creating the administrator.

The source-owned feed and passkey illustrations are enumerated in `contracts/system-media.json` and copied into a generated directory at build time. Service identifiers `public/fire-assets/brands/{postgresql.svg,redis.png}` reuse the original Alcor interface assets; those marks remain the property of their respective owners and are not covered by the code license. Neither path depends on the user uploads mount.

## Stock and ETF reference data

Web and App security search can read the [SEC exchange directory](https://www.sec.gov/file/company-tickers-exchange). Configure a `public_sec_targets` entry with `kind: security-directory`, its ID, approved `directory_addresses`, and a declared SEC `user_agent`. Bind it to an independent `public_reference_policies` entry with the adapter version `sec-company-tickers-exchange-v1`, the target fingerprint, the US market, and the `collect` and `display` purposes. Install the policy through the existing public-reference administrator endpoint.

Set `refresh_daily: true` on the target before installing the policy to collect once per UTC day. Administrators can also collect with `{"market":"US"}`. The worker retains the original and the capture receipt. A source outage leaves the last verified capture available for up to seven days. The directory supplies issuer names, tickers and exchange only. Searchable entries without artwork appear in the material search with an upload control. A confirmed listing can also be added to the bundled directory with its exchange announcement.

When a stock icon row shows 待核实跟踪标的, check the issuer prospectus or exchange product notice before adding the relationship to `platform/backend/alcor_api/data/discovery-related-etfs.json`. When the row reports a missing underlying icon, upload the artwork on the underlying equity's material entry. Keep the ETF ticker and underlying ticker distinct.
