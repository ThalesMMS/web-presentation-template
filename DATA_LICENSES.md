# Data licenses and provenance

This project's original code and documentation use the MIT license. It
**does not replace** the terms for image datasets distributed in
`public/dicom-slide/exams/library/`.

## Visible Human Male — abdominal CT

- Package: `public/dicom-slide/exams/library/visible-human-abdomen-ct/`
- Source: [Visible Human Project, U.S. National Library of Medicine](https://www.nlm.nih.gov/research/visible/visible_human.html)
- Source images: `normalCT` and `frozenCT` radiology series, indices 1500–1800;
  the normal acquisition does not include index 1557.
- Legal status stated by NLM: the library is in the public domain; no access
  license has been required since 2019.
- Additional redistribution terms:
  [NLM Terms and Conditions](https://www.nlm.nih.gov/databases/download/terms_and_conditions.html).
- Required attribution: **“Courtesy of the U.S. National Library of Medicine.”**

This project reduces the images from 512 × 512 to 256 × 256 with nearest-neighbor
sampling, converts the stored value to HU using `HU = value − 1024`, and packages
pixels as Int16/gzip/base64. Each series manifest records the interval, aggregate
source-image hash, and applied transformation. The normal CT includes one
synthetic slice at −165 mm, linearly interpolated in HU between the acquired
slices at −168 and −162 mm to preserve their physical separation. Its 100 source
images therefore produce 101 output slices.

This attribution does not mean that NLM approved, certified, sponsored, or maintains this software.
Under the NLM terms, redistributors must also warn that the data may not be
current or accurate. No warranties are provided.

## MRI-DIR — multi-series synthetic T1 MR

- Package: `public/dicom-slide/exams/library/mri-dir-t1-mr/`
- Collection: [Synthetic and Phantom MR Images for Determining Deformable Image Registration Accuracy (MRI-DIR)](https://www.cancerimagingarchive.net/collection/mri-dir/)
- Case: `MRI-DIR-T1_1`, four series (`T1Post1`–`T1Post4`), 56 images.
- Data license: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
- Full text: [`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt).
- Notice provided with the TCIA download:
  [`LICENSES/MRI-DIR-TCIA.txt`](LICENSES/MRI-DIR-TCIA.txt).

The images are synthetic/modelled from head-and-neck images and support
deformable-registration evaluation; they do not represent a multi-sequence
diagnostic acquisition. The project only removes DICOM containers from the
runtime and repackages stored values in Int16 chunks, preserving geometry, order,
and pixel values.

Data citation:

> Ger, R. B., Yang, J., Ding, Y., Jacobsen, M. C., Cardenas, C. E., Fuller,
> C. D., Howell, R. M., Li, H., Stafford, R. J., Zhou, S., & Court, L. (2018).
> *Data from Synthetic and Phantom MR Images for Determining Deformable Image
> Registration Accuracy (MRI-DIR)* (Version 1). The Cancer Imaging Archive.
> https://doi.org/10.7937/K9/TCIA.2018.3f08iejt

TCIA requires acknowledgement of the specific dataset and NIH repository in
oral or written presentations, disclosures, and publications. Attempts to
re-identify or contact participants are prohibited. Also see the
[TCIA data-usage policy](https://wiki.cancerimagingarchive.net/display/Public/Data%2BUsage%2BPolicies%2Band%2BRestrictions).

## Intended use

Both packages are included for technical demonstration, education, and research.
They are not intended for diagnosis, treatment planning, or clinical
decision-making. Follow the dataset attribution and citation requirements above
before reusing images in a presentation.
