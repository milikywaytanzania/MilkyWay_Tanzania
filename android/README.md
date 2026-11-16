# MilkyWay Android release

The Android project is generated from `@capacitor/android` into `android/capacitor` by the release workflow. Native overrides live in `android/native-src` and are copied into that generated project before each build.

The app starts at `https://www.masiyatunda.com/milkyway/`, the canonical app URL that returns without a redirect. The native plugin provides the in-app Back/Exit action, secure external HTTPS links, app version information, and Firebase client initialization.

The workflow builds a signed release APK. Before running `.github/workflows/android-apk.yml`, add these repository Actions secrets using the existing Android release keystore:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

Never commit the keystore or its passwords. The workflow decodes the base64 keystore into the runner's temporary directory and passes signing credentials to Gradle through environment variables; credentials are not written into the generated project. On a successful build, Actions commits the generated Android project and signed `milkyway/download/MilkyWay.apk` to the branch that triggered the build.

## Google Play coin purchases

The Android app uses `@capgo/native-purchases` with Google Play Billing. Create these one-time in-app products in Play Console and configure their localized prices:

| Product ID | Coins |
| --- | ---: |
| `mw_coins_10` | 10 |
| `mw_coins_50` | 50 |
| `mw_coins_100` | 100 |
| `mw_coins_500` | 500 |
| `mw_coins_1000` | 1,000 |

These are consumable products. Upload an internal-testing build, add license testers, and ensure the Google Play Developer API is enabled and its service account can view and manage orders for this app. The Android package name is `com.masiyatunda.milkyway`.

Apply `supabase/migrations/20261121_milkyway_google_play_billing.sql` after the wallet schema migration, deploy `google-play-verify` with `supabase functions deploy google-play-verify`, and configure the private `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` secret with the service-account JSON key contents. Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions.

Never put the service-account key or service-role key in the app, client configuration, or source control. The Edge Function verifies each token with Google Play before crediting coins, binds it to the account identifier supplied in the native billing request, and consumes the purchase only after the wallet transaction succeeds. Coin package quantities are controlled by the server, not by client-submitted values.

After adding or updating the plugin, run `npm ci` and `npx cap sync android` before building the APK. The release preparation step preserves the Play Billing manifest permission.
