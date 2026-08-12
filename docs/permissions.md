# Permissions

A packaged `Grok Dictate.app` is its own TCC identity. Grants you made to Terminal while running `npm run dev` do not transfer.

| Permission       | Why                                           | If missing                                                 |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Microphone       | Audio is captured only while a turn is active | HUD error; orange indicator never appears                  |
| Accessibility    | The helper types into the frontmost app       | Transcript is kept; menu bar offers a shortcut to the pane |
| Input Monitoring | Global `Fn` detection                         | Menu bar says the Fn key is not being detected             |

Reset this app’s grants (you will be asked again on next launch):

```bash
tccutil reset All com.fynnius.grokdictate
```

Ad-hoc signatures change when the binary bytes change, so a rebuild may look like a new app to macOS. That is expected until the app is Developer ID signed.

## Gatekeeper

Downloads from the internet are quarantined. This build is ad-hoc signed, not Developer ID signed and not notarized. On macOS Sequoia and later, double-clicking it shows **“Grok Dictate Not Opened”** with only **Move to Trash** and **Done**. That is Gatekeeper, not a corrupt zip. Right-click → Open no longer overrides this.

Apple’s supported override:

1. Click **Done** (do not move it to Trash).
2. Open **System Settings → Privacy & Security**.
3. Scroll to **Security**. You should see that Grok Dictate was blocked.
4. Click **Open Anyway**, then confirm.

After that first exception, double-clicking works normally.

Terminal alternative, if you prefer:

```bash
xattr -dr com.apple.quarantine "/Applications/Grok Dictate.app"
open -a "Grok Dictate"
```

Do not disable SIP or Gatekeeper system-wide. See [Apple’s guide](https://support.apple.com/en-us/102445).
