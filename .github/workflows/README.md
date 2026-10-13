# Tickoff

To-do and shopping lists in a static web page. No account is needed to use it. Lists are saved on the device, and optionally synced between devices through a secret gist in your own GitHub account.

## Put it online (GitHub Pages)

1. Create a new repository on GitHub, for example `tickoff`.
2. From this folder:
   ```
   git init
   git add .
   git commit -m "Tickoff"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/tickoff.git
   git push -u origin main
   ```
3. In the repository go to **Settings > Pages**, set **Source** to "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute the app is live at `https://YOUR-USERNAME.github.io/tickoff/`.

## Turn on sync (once per device)

1. Tap the status chip at the top right ("On this device").
2. Follow the link to create a **classic** token with only the **gist** box ticked, and paste it in.
3. On your other devices, paste the same token, or on a connected device choose "Setup link for another device" and open that link on the new one.

The first device to connect creates a secret gist named `tickoff.json`. Every other device finds it by itself.

## Install it like an app

- **iPhone or iPad:** open the page in Safari, tap Share, then "Add to Home Screen".
- **Mac or Linux (Chrome, Edge, Chromium):** use the install icon in the address bar. Firefox and Safari on Mac just work as a bookmark.

The page works offline after the first visit. Changes made offline sync when you are back online.

## Things to know

- The token is stored in the browser on each device and only ever sent to `api.github.com`. It can read and write your gists, so treat it like a password. You can revoke it any time at github.com/settings/tokens.
- A secret gist is unlisted, not private: anyone who has its URL can read it. Do not put passwords in lists.
- If two devices edit the same item at the same time, the later edit wins. Different items merge cleanly.
- After changing any app file, bump `CACHE` in `sw.js` so devices fetch the new version.
