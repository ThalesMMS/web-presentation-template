# Third-party licenses

## QRCode.js 1.0.0

Copyright (c) 2012 davidshimjs

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## DICOM Slides runtime and importer

The DICOM Slides viewer runtime in `public/dicom-slide/runtime/` and browser
importer in `public/dicom-slide/importer/` are distributed under the **MIT
License**.

Copyright (c) 2026 Thales Matheus Mendonça Santos.

See the full notice in [LICENSES/dicom-slides-MIT.txt](LICENSES/dicom-slides-MIT.txt).
The vendored decoders have additional notices below.

## CharLS WASM decoder

The JPEG-LS decoder in `public/dicom-slide/importer/vendor/charls/` includes:

- **MIT License** for the WASM wrapper, copyright (c) 2020 Chris Hafey. See
  [LICENSE](public/dicom-slide/importer/vendor/charls/LICENSE).
- **BSD 3-Clause License** for CharLS, copyright (c) 2007 Jan de Vaan and
  Victor Derks. See
  [LICENSE-CHARLS](public/dicom-slide/importer/vendor/charls/LICENSE-CHARLS).

Retain both notices when redistributing the decoder.

## OpenJPEG WASM decoder

The JPEG 2000 decoder in `public/dicom-slide/importer/vendor/openjpeg/` includes:

- **MIT License** for the WASM wrapper, copyright (c) 2019 Open Health Imaging
  Foundation. See [LICENSE](public/dicom-slide/importer/vendor/openjpeg/LICENSE).
- **BSD 2-Clause License** for OpenJPEG. Its copyright holders include
  Universite catholique de Louvain (UCL), Professor Benoit Macq, Antonin
  Descampe, Francois-Olivier Devaux, Herve Drolon / FreeImage Team, Yannick
  Verschueren, David Janssens, Centre National d'Etudes Spatiales (CNES), and
  CS Systemes d'Information. See the complete notice and copyright years in
  [LICENSE-OPENJPEG](public/dicom-slide/importer/vendor/openjpeg/LICENSE-OPENJPEG).

Retain both notices when redistributing the decoder.

## Imaging datasets

The imaging datasets have their own terms and attribution requirements. See
[DATA_LICENSES.md](DATA_LICENSES.md) for the Visible Human abdominal CT and
MRI-DIR synthetic T1 MR data distributed in
`public/dicom-slide/exams/library/`.
