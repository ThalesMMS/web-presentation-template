# Vendored JPEG 2000 decoder

`openjpegwasm_decode.js` and `openjpegwasm_decode.wasm` come from
`@cornerstonejs/codec-openjpeg` 1.3.0. The package wrapper is licensed under
the MIT terms in `LICENSE`; the compiled OpenJPEG codec is covered by the
2-clause BSD terms in `LICENSE-OPENJPEG`.

The decoder is loaded from the same origin as the PowerPoint add-in. It does
not make a network request other than loading its local Wasm binary.
