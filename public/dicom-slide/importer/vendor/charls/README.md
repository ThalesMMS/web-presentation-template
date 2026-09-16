# Vendored JPEG-LS decoder

`charlswasm_decode.js` and `charlswasm_decode.wasm` come from
`@cornerstonejs/codec-charls` 1.2.5. The package wrapper is licensed under
the MIT terms in `LICENSE`; the compiled CharLS codec is covered by the
BSD 3-Clause terms in `LICENSE-CHARLS`.

SHA-256:

- `charlswasm_decode.js`: `c8ef100ac02552c692d59e60f61ab9dc84f355a62386d571e3db2c1046aa1f5a`
- `charlswasm_decode.wasm`: `a8b192966b58218713ac09750a6bf6560d22fe12906600b88fcd49ff0d001e04`

The files are loaded locally by `powerpoint/content.html`; no external codec
service is used at runtime.
