# SlogaStore

The iOS app's in-app Prot purchases (Prot S6): the Capacitor plugin `ProtStore`, built on
StoreKit 2 (iOS 15+). The page's side is `packages/client/components/client/protStorePlugin.ts`.
The contract is S6 contracts §20 (plugin), §25 (iOS), §35 (event order), §28 (controls).

## Registration (lane L4d)

`SlogaE2ee` depends on this package (`.package(path: "../SlogaStore")`, product `SlogaStore`)
because the bridge view controller lives there. In
`SlogaE2ee/Sources/SlogaE2ee/SlogaBridgeViewController.swift`, `import SlogaStore`, then inside
`if bridgeGuard != nil {`, right after `bridge.registerPluginInstance(E2eePlugin())`:

```swift
                // In-app Prot (S6). Behind the same guard: an embed frame must never open a store sheet.
                ProtStorePlugin.arm()
                bridge.registerPluginInstance(ProtStorePlugin())
```

These are the only public entry points: `ProtStorePlugin` (public final class, inherited `init()`)
and `ProtStorePlugin.arm()`. An instance that was never armed answers "not available" to every call
and starts no listener.

## Methods (JS name `ProtStore`)

| JS | StoreKit 2 |
|---|---|
| `isAvailable()` → `{available}` | `AppStore.canMakePayments` |
| `products({ids})` → `{products: [{id, displayPrice}]}` | `Product.products(for:)`, consumables only, request order |
| `purchase({product_id, account_token})` → result union | token checked as a UUID first (`invalid_token`, no sheet); `product.purchase(options: [.appAccountToken(uuid)])`; `.success` (verified or not) → `purchased` with `jwsRepresentation`, NOT finished; `.pending` → `pending`; `.userCancelled` → `cancelled`; errors → `failed{code}` |
| `pendingTransactions()` → `{purchases}` | `Transaction.unfinished` |
| `finish({transaction_id})` → `{finished}` | looks the id up in `Transaction.unfinished`, `.finish()` |
| `storefront()` → `{storefront?}` | `Storefront.current?.countryCode`, raw alpha-3 (the server maps it, §8.5) |
| event `transactionUpdated` | `Transaction.updates`, started in `load()`; held while a purchase is open and released only after that `purchase()` promise resolved (§35) |

One purchase at a time: a second `purchase()` while a sheet is open answers
`failed{store_error, "purchase_open"}` (R44, Android parity). `products(ids)` drops invalid ids
silently and returns the valid ones (R45).

`product.purchase(options:)` is the iOS 15 API the contract pins; newer SDKs may flag it as
deprecated in favor of `purchase(confirmIn:options:)`. That is a warning only (NIT 11, recorded).

Never: finishing outside `finish()`, trusting local verification, logging a JWS or token, promoted
IAP (E10), any web purchase link (E8).

## Tests

```
cd packages/client/ios/App/SlogaStore
xcodebuild -scheme SlogaStore test -destination 'platform=iOS Simulator,name=<an iPhone simulator>'
```

- `ProtStoreResultsTests`, `ProtStoreUpdateGateTests`: pure; the source-scan cases read
  `Sources/` through `#filePath`, so they need the simulator on the Mac (they fail on a device).
- `SlogaStoreTests`: StoreKit testing with `SKTestSession` and `Tests/SlogaStoreTests/Prot.storekit`
  (the five packs at $5.99 / $11.99 / $29.99 / $58.99 / $117.99). Simulator only.

Known-bad controls: `/home/mcp/pc-logs/s6/L4c/` (each patch names the test that must fail).
