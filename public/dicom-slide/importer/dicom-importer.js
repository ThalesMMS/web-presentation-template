(function (global) {
  "use strict";

  const DB_NAME = "dicom-slides-powerpoint";
  const DB_VERSION = 1;
  const PACKAGE_STORE = "packages";
  const LOCAL_PROTOCOL = "dicom-slides-local:";
  const DEFAULT_CHUNK_SIZE = 12;
  const MAX_INPUT_FILES = 10000;
  const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
  const MAX_PIXEL_BYTES = 512 * 1024 * 1024;

  const IMPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2";
  const EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
  const EXPLICIT_VR_BIG_ENDIAN = "1.2.840.10008.1.2.2";
  const JPEG2000_TRANSFER_SYNTAXES = new Set([
    "1.2.840.10008.1.2.4.90",
    "1.2.840.10008.1.2.4.91",
  ]);
  const JPEGLS_LOSSLESS_TRANSFER_SYNTAX = "1.2.840.10008.1.2.4.80";
  const JPEGLS_NEAR_LOSSLESS_TRANSFER_SYNTAX = "1.2.840.10008.1.2.4.81";
  const JPEGLS_TRANSFER_SYNTAXES = new Set([
    JPEGLS_LOSSLESS_TRANSFER_SYNTAX,
    JPEGLS_NEAR_LOSSLESS_TRANSFER_SYNTAX,
  ]);
  const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
    IMPLICIT_VR_LITTLE_ENDIAN,
    EXPLICIT_VR_LITTLE_ENDIAN,
    EXPLICIT_VR_BIG_ENDIAN,
  ]);

  const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UR", "UT", "UN", "OV", "SV", "UV"]);
  const TEXT_VR = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT", "UN"]);
  const VALID_VR = new Set([
    "AE", "AS", "AT", "CS", "DA", "DS", "DT", "FD", "FL", "IS", "LO", "LT", "OB", "OD", "OF", "OL",
    "OV", "OW", "PN", "SH", "SL", "SQ", "SS", "ST", "SV", "TM", "UC", "UI", "UL", "UN", "UR", "US",
    "UT", "UV",
  ]);

  const TARGETS = Object.freeze({
    "00020010": "transferSyntaxUID",
    "00080005": "specificCharacterSet",
    "00080020": "studyDate",
    "00080050": "accessionNumber",
    "00080060": "modality",
    "00080080": "institutionName",
    "00081030": "studyDescription",
    "0008103e": "seriesDescription",
    "00100010": "patientName",
    "00100020": "patientID",
    "00180050": "sliceThickness",
    "00180088": "spacingBetweenSlices",
    "0020000d": "studyInstanceUID",
    "0020000e": "seriesInstanceUID",
    "00200011": "seriesNumber",
    "00200013": "instanceNumber",
    "00200032": "imagePositionPatient",
    "00200037": "imageOrientationPatient",
    "00201041": "sliceLocation",
    "00280002": "samplesPerPixel",
    "00280004": "photometricInterpretation",
    "00280006": "planarConfiguration",
    "00280008": "numberOfFrames",
    "00280010": "rows",
    "00280011": "columns",
    "00280030": "pixelSpacing",
    "00280100": "bitsAllocated",
    "00280101": "bitsStored",
    "00280102": "highBit",
    "00280103": "pixelRepresentation",
    "00280301": "burnedInAnnotation",
    "00281050": "windowCenter",
    "00281051": "windowWidth",
    "00281052": "rescaleIntercept",
    "00281053": "rescaleSlope",
  });

  const IMPLICIT_VR_BY_TAG = Object.freeze({
    "00280002": "US",
    "00280006": "US",
    "00280010": "US",
    "00280011": "US",
    "00280100": "US",
    "00280101": "US",
    "00280102": "US",
    "00280103": "US",
    "7fe00010": "OW",
  });

  const DICOM_ENCODINGS = Object.freeze({
    "": "windows-1252",
    "ISO_IR 6": "windows-1252",
    "ISO_IR 100": "iso-8859-1",
    "ISO_IR 101": "iso-8859-2",
    "ISO_IR 109": "iso-8859-3",
    "ISO_IR 110": "iso-8859-4",
    "ISO_IR 144": "iso-8859-5",
    "ISO_IR 127": "iso-8859-6",
    "ISO_IR 126": "iso-8859-7",
    "ISO_IR 138": "iso-8859-8",
    "ISO_IR 148": "iso-8859-9",
    "ISO_IR 166": "windows-874",
    "ISO_IR 13": "shift_jis",
    "ISO_IR 192": "utf-8",
    "GB18030": "gb18030",
    "GBK": "gbk",
  });

  const GENERIC_CT_PRESETS = Object.freeze({
    dicom: { label: "DICOM", center: 40, width: 400 },
    soft: { label: "Soft tissue", center: 40, width: 400 },
    lung: { label: "Lung", center: -600, width: 1500 },
    bone: { label: "Bone", center: 500, width: 2000 },
  });

  const databaseReady = openDatabase().catch(() => null);
  let openJpegModulePromise = null;
  let charLsModulePromise = null;

  function abortIfRequested(signal) {
    if (signal?.aborted) throw new DOMException("Import canceled.", "AbortError");
  }

  function report(callback, phase, progress, message, detail = {}) {
    if (typeof callback !== "function") return;
    callback(Object.assign({ phase, progress: Math.max(0, Math.min(1, progress)), message }, detail));
  }

  function yieldToUi() {
    return new Promise((resolve) => global.setTimeout(resolve, 0));
  }

  function tagId(group, element) {
    return group.toString(16).padStart(4, "0") + element.toString(16).padStart(4, "0");
  }

  function safeText(meta, key) {
    const value = meta?.[key];
    return value == null ? "" : String(value).trim();
  }

  function firstNumber(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const number = Number(String(value).split("\\", 1)[0].trim());
    return Number.isFinite(number) ? number : fallback;
  }

  function splitNumbers(value) {
    if (!value) return [];
    return String(value).split("\\").map((part) => Number(part.trim())).filter(Number.isFinite);
  }

  function slugify(value, fallback) {
    let normalized = String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (!normalized) normalized = fallback;
    return normalized;
  }

  async function shortHash(value, length = 10) {
    const bytes = new TextEncoder().encode(String(value));
    if (global.crypto?.subtle) {
      const digest = new Uint8Array(await global.crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
    }
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0").repeat(2).slice(0, length);
  }

  function textDecoderFor(specificCharacterSet) {
    const declared = String(specificCharacterSet || "").split("\\").map((item) => item.trim()).filter(Boolean);
    if (declared.length > 1 || declared[0]?.startsWith("ISO 2022 ")) return new TextDecoder("windows-1252");
    const label = DICOM_ENCODINGS[declared[0] || ""] || "windows-1252";
    try {
      return new TextDecoder(label);
    } catch (_) {
      return new TextDecoder("windows-1252");
    }
  }

  function decodeText(bytes, decoder) {
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end -= 1;
    return decoder.decode(bytes.subarray(0, end));
  }

  function decodeValue(vr, bytes, decoder, littleEndian) {
    if (TEXT_VR.has(vr)) return decodeText(bytes, decoder);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (vr === "US" && bytes.byteLength >= 2) {
      const values = [];
      for (let offset = 0; offset + 2 <= bytes.byteLength; offset += 2) values.push(view.getUint16(offset, littleEndian));
      return values.length === 1 ? values[0] : values;
    }
    if (vr === "SS" && bytes.byteLength >= 2) {
      const values = [];
      for (let offset = 0; offset + 2 <= bytes.byteLength; offset += 2) values.push(view.getInt16(offset, littleEndian));
      return values.length === 1 ? values[0] : values;
    }
    if (vr === "UL" && bytes.byteLength >= 4) {
      const values = [];
      for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 4) values.push(view.getUint32(offset, littleEndian));
      return values.length === 1 ? values[0] : values;
    }
    if (vr === "SL" && bytes.byteLength >= 4) {
      const values = [];
      for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 4) values.push(view.getInt32(offset, littleEndian));
      return values.length === 1 ? values[0] : values;
    }
    return null;
  }

  function findSequenceDelimiter(bytes, offset, littleEndian) {
    const pattern = littleEndian
      ? [0xfe, 0xff, 0xdd, 0xe0]
      : [0xff, 0xfe, 0xe0, 0xdd];
    for (let index = offset; index + 8 <= bytes.length; index += 1) {
      if (bytes[index] === pattern[0] && bytes[index + 1] === pattern[1]
          && bytes[index + 2] === pattern[2] && bytes[index + 3] === pattern[3]) {
        return index + 8;
      }
    }
    return bytes.length;
  }

  function parseDicomBuffer(input, sourceName = "DICOM", requirePixels = false) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hasPreamble = bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49
      && bytes[130] === 0x43 && bytes[131] === 0x4d;
    let offset = hasPreamble ? 132 : 0;
    const probedVr = bytes.length >= offset + 6
      ? String.fromCharCode(bytes[offset + 4], bytes[offset + 5])
      : "";
    let explicit = hasPreamble || VALID_VR.has(probedVr);
    let littleEndian = true;
    let transferSyntax = explicit ? EXPLICIT_VR_LITTLE_ENDIAN : IMPLICIT_VR_LITTLE_ENDIAN;
    let decoder = textDecoderFor("");
    let inFileMeta = hasPreamble;
    const meta = { sourceName, transferSyntaxUID: transferSyntax };

    while (offset + 8 <= bytes.length) {
      let group;
      let element;
      let fileMetaElement = false;

      if (inFileMeta) {
        const littleGroup = view.getUint16(offset, true);
        const littleElement = view.getUint16(offset + 2, true);
        if (littleGroup === 0x0002) {
          group = littleGroup;
          element = littleElement;
          fileMetaElement = true;
        } else {
          inFileMeta = false;
          explicit = transferSyntax !== IMPLICIT_VR_LITTLE_ENDIAN;
          littleEndian = transferSyntax !== EXPLICIT_VR_BIG_ENDIAN;
          group = view.getUint16(offset, littleEndian);
          element = view.getUint16(offset + 2, littleEndian);
        }
      } else {
        group = view.getUint16(offset, littleEndian);
        element = view.getUint16(offset + 2, littleEndian);
      }

      const valueLittleEndian = fileMetaElement ? true : littleEndian;
      const valueExplicit = fileMetaElement || explicit;
      offset += 4;

      let vr;
      let length;
      if (valueExplicit) {
        if (offset + 4 > bytes.length) break;
        vr = String.fromCharCode(bytes[offset], bytes[offset + 1]);
        offset += 2;
        if (LONG_VR.has(vr)) {
          offset += 2;
          if (offset + 4 > bytes.length) break;
          length = view.getUint32(offset, valueLittleEndian);
          offset += 4;
        } else {
          length = view.getUint16(offset, valueLittleEndian);
          offset += 2;
        }
      } else {
        if (offset + 4 > bytes.length) break;
        const id = tagId(group, element);
        vr = IMPLICIT_VR_BY_TAG[id] || "UN";
        length = view.getUint32(offset, valueLittleEndian);
        offset += 4;
      }

      const id = tagId(group, element);
      if (id === "7fe00010") {
        meta.pixelOffset = offset;
        meta.pixelLength = length;
        meta.pixelVR = vr;
        break;
      }

      if (length === 0xffffffff) {
        offset = findSequenceDelimiter(bytes, offset, valueLittleEndian);
        continue;
      }
      if (length < 0 || offset + length > bytes.length) break;

      const name = TARGETS[id];
      if (name) {
        const valueBytes = bytes.subarray(offset, offset + length);
        const valueDecoder = name === "specificCharacterSet" ? textDecoderFor("") : decoder;
        const value = decodeValue(vr, valueBytes, valueDecoder, valueLittleEndian);
        if (value != null) {
          meta[name] = value;
          if (name === "transferSyntaxUID") transferSyntax = String(value).trim();
          if (name === "specificCharacterSet") decoder = textDecoderFor(String(value));
        }
      }
      offset += length;
    }

    const required = ["rows", "columns", "bitsAllocated", "pixelRepresentation"];
    if (requirePixels) required.push("pixelOffset", "pixelLength");
    const missing = required.filter((key) => meta[key] == null);
    if (missing.length) throw new Error(`${sourceName}: campos DICOM ausentes: ${missing.join(", ")}`);
    return meta;
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function dot(a, b) {
    return a.reduce((sum, value, index) => sum + value * b[index], 0);
  }

  function sliceCoordinate(meta) {
    const orientation = splitNumbers(meta.imageOrientationPatient);
    const position = splitNumbers(meta.imagePositionPatient);
    if (orientation.length >= 6 && position.length >= 3) {
      return dot(position.slice(0, 3), cross(orientation.slice(0, 3), orientation.slice(3, 6)));
    }
    return firstNumber(meta.sliceLocation, firstNumber(meta.instanceNumber, 0));
  }

  function hasConsistentOrientation(records, tolerance = 1e-4) {
    if (!records.length) return false;
    const reference = splitNumbers(records[0].imageOrientationPatient);
    if (reference.length < 6) return false;
    return records.slice(1).every((record) => {
      const orientation = splitNumbers(record.imageOrientationPatient);
      return orientation.length >= 6
        && reference.slice(0, 6).every((value, index) => Math.abs(value - orientation[index]) <= tolerance);
    });
  }

  function sortSeriesRecords(records) {
    if (hasConsistentOrientation(records)) {
      return { records: records.slice().sort((left, right) => sliceCoordinate(left) - sliceCoordinate(right)), sortMode: "spatial" };
    }
    return {
      records: records.slice().sort((left, right) => firstNumber(left.instanceNumber, 0) - firstNumber(right.instanceNumber, 0)),
      sortMode: "instance",
    };
  }

  function supportedRecordReason(meta) {
    const transferSyntax = safeText(meta, "transferSyntaxUID") || EXPLICIT_VR_LITTLE_ENDIAN;
    const isJpeg2000 = JPEG2000_TRANSFER_SYNTAXES.has(transferSyntax);
    const isJpegLs = JPEGLS_TRANSFER_SYNTAXES.has(transferSyntax);
    const isEncapsulated = isJpeg2000 || isJpegLs;
    if (!UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntax) && !isEncapsulated) {
      return `compressed or unsupported transfer syntax (${transferSyntax})`;
    }
    if (meta.pixelOffset == null || meta.pixelLength == null) return "missing Pixel Data";
    if (isEncapsulated && meta.pixelLength !== 0xffffffff) {
      return `${isJpegLs ? "JPEG-LS" : "JPEG 2000"} Pixel Data is not encapsulated`;
    }
    if (!isEncapsulated && meta.pixelLength === 0xffffffff) {
      return "encapsulated Pixel Data requires a supported codec";
    }
    if (firstNumber(meta.numberOfFrames, 1) !== 1) return "only single-frame images are supported";

    const samples = Number(meta.samplesPerPixel || 1);
    const bits = Number(meta.bitsAllocated);
    const bitsStored = Number(meta.bitsStored || bits);
    const highBit = Number(meta.highBit ?? (bitsStored - 1));
    const signed = Number(meta.pixelRepresentation || 0) === 1;
    const photometric = safeText(meta, "photometricInterpretation").toUpperCase();

    if (![1, 3].includes(samples)) return `Samples per Pixel ${samples}; expected 1 or 3`;
    if (samples === 1 && ![8, 16].includes(bits)) return `Bits Allocated ${bits}; expected 8 or 16`;
    if (samples === 3 && bits !== 8) return "color images must use three 8-bit allocated samples";
    if (!Number.isInteger(bitsStored) || bitsStored < 1 || bitsStored > bits) {
      return `Bits Stored ${meta.bitsStored}; expected 1-${bits}`;
    }
    if (isJpegLs && (bitsStored < 2 || highBit !== bitsStored - 1)) {
      return `JPEG-LS requires Bits Stored 2-${bits} and High Bit equal to Bits Stored - 1`;
    }
    if (isJpeg2000 && bits === 8 && signed) {
      return "signed 8-bit JPEG 2000 is not supported by the local decoder";
    }
    if (isJpegLs && samples === 1 && !["MONOCHROME1", "MONOCHROME2"].includes(photometric)) {
      if (photometric === "PALETTE COLOR") return "JPEG-LS PALETTE COLOR requires lookup-table support";
      return `JPEG-LS monochrome color space ${photometric || "unknown"}; expected MONOCHROME1 or MONOCHROME2`;
    }
    if (isJpegLs && samples === 3) {
      if (signed) return "JPEG-LS color images must use unsigned samples";
      if (!["RGB", "YBR_FULL"].includes(photometric)) {
        return `JPEG-LS color space ${photometric || "unknown"}; expected RGB or YBR_FULL`;
      }
      if (bitsStored > 8) return "JPEG-LS color input above 8 Bits Stored is not supported by the RGB8 package format";
    } else if (samples === 3 && photometric !== "RGB") {
      return `color space ${photometric || "unknown"}; expected RGB`;
    }
    return null;
  }

  function isJpeg2000Record(record) {
    return JPEG2000_TRANSFER_SYNTAXES.has(safeText(record, "transferSyntaxUID"));
  }

  function isJpegLsRecord(record) {
    return JPEGLS_TRANSFER_SYNTAXES.has(safeText(record, "transferSyntaxUID"));
  }

  async function readSourceBytes(source) {
    const result = await source.read();
    return result instanceof Uint8Array ? result : new Uint8Array(result);
  }

  function extractEncapsulatedSingleFrame(record, bytes) {
    if (firstNumber(record.numberOfFrames, 1) !== 1) {
      throw new Error("Only single-frame encapsulated DICOM input is supported.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fragments = [];
    let totalLength = 0;
    let itemIndex = 0;
    let offset = Number(record.pixelOffset);

    while (offset + 8 <= bytes.length) {
      const group = view.getUint16(offset, true);
      const element = view.getUint16(offset + 2, true);
      const length = view.getUint32(offset + 4, true);
      offset += 8;
      if (group === 0xfffe && element === 0xe0dd) {
        if (length !== 0) throw new Error("Encapsulated Pixel Data sequence delimiter has a non-zero length.");
        if (!fragments.length) throw new Error("Encapsulated frame has no pixel fragments.");
        const frame = new Uint8Array(totalLength);
        let writeOffset = 0;
        fragments.forEach((fragment) => {
          frame.set(fragment, writeOffset);
          writeOffset += fragment.byteLength;
        });
        return frame;
      }
      if (group !== 0xfffe || element !== 0xe000) throw new Error("Expected an encapsulated Pixel Data item.");
      if (length === 0xffffffff || offset + length > bytes.length) {
        throw new Error("Encapsulated pixel fragment is truncated.");
      }
      if (itemIndex > 0) {
        const fragment = bytes.subarray(offset, offset + length);
        fragments.push(fragment);
        totalLength += fragment.byteLength;
      }
      itemIndex += 1;
      offset += length;
    }
    throw new Error("Encapsulated frame is missing the Sequence Delimitation Item.");
  }

  async function openJpegModule() {
    if (!openJpegModulePromise) {
      if (typeof global.OpenJPEGWASM !== "function") {
        throw new Error("The local JPEG 2000 decoder is unavailable.");
      }
      openJpegModulePromise = Promise.resolve(global.OpenJPEGWASM({
        print() {},
        printErr() {},
      })).catch((error) => {
        openJpegModulePromise = null;
        throw new Error(`Could not initialize the local JPEG 2000 decoder: ${error.message}`);
      });
    }
    return openJpegModulePromise;
  }

  async function decodeJpeg2000(record) {
    const bytes = record.sourceBytes || await readSourceBytes(record.source);
    const encodedFrame = extractEncapsulatedSingleFrame(record, bytes);
    const openJpeg = await openJpegModule();
    const decoder = new openJpeg.J2KDecoder();
    try {
      decoder.getEncodedBuffer(encodedFrame.byteLength).set(encodedFrame);
      decoder.decode();
      const frameInfo = decoder.getFrameInfo();
      const expectedWidth = Number(record.columns);
      const expectedHeight = Number(record.rows);
      const expectedComponents = Number(record.samplesPerPixel || 1);
      const expectedSigned = Number(record.pixelRepresentation || 0) === 1;
      if (frameInfo.width !== expectedWidth || frameInfo.height !== expectedHeight) {
        throw new Error(`JPEG 2000 dimensions are ${frameInfo.width}x${frameInfo.height}; expected ${expectedWidth}x${expectedHeight}.`);
      }
      if (frameInfo.componentCount !== expectedComponents) {
        throw new Error(`JPEG 2000 frame has ${frameInfo.componentCount} components; expected ${expectedComponents}.`);
      }
      if (!Number.isInteger(frameInfo.bitsPerSample)
          || frameInfo.bitsPerSample < 1
          || frameInfo.bitsPerSample > 16) {
        throw new Error(`JPEG 2000 uses unsupported ${frameInfo.bitsPerSample}-bit samples; expected 1-16.`);
      }
      if (Boolean(frameInfo.isSigned) !== expectedSigned) {
        throw new Error("JPEG 2000 signedness does not match DICOM Pixel Representation.");
      }
      return {
        bytes: Uint8Array.from(decoder.getDecodedBuffer()),
        bitsPerSample: frameInfo.bitsPerSample,
        isSigned: Boolean(frameInfo.isSigned),
      };
    } catch (error) {
      throw new Error(`Could not decode JPEG 2000 frame: ${error.message}`);
    } finally {
      decoder.delete();
    }
  }



  function codecErrorMessage(error, module) {
    if (typeof error === "number" && typeof module?.getExceptionMessage === "function") {
      try {
        return String(module.getExceptionMessage(error));
      } catch (_) {
        // Fall through to the generic representation.
      }
    }
    return error?.message || String(error);
  }

  function trimJpegEndPadding(bytes) {
    const end = bytes.byteLength;
    if (end >= 3 && bytes[end - 1] === 0 && bytes[end - 3] === 0xff && bytes[end - 2] === 0xd9) {
      return bytes.subarray(0, end - 1);
    }
    return bytes;
  }

  function locateCharLsFile(fileName) {
    if (typeof document === "undefined" || !fileName.endsWith(".wasm")) return fileName;
    const scripts = Array.from(document.scripts || []);
    const codecScript = scripts.find((script) => /\/vendor\/charls\/charlswasm_decode\.js(?:[?#]|$)/.test(script.src));
    if (codecScript?.src) return new URL(fileName, codecScript.src).href;
    if (global.location?.href) return new URL(`vendor/charls/${fileName}`, global.location.href).href;
    return fileName;
  }

  async function openCharLsModule() {
    if (!charLsModulePromise) {
      if (typeof global.CharLSWASM !== "function") {
        throw new Error("The local JPEG-LS decoder is unavailable.");
      }
      const options = { print() {}, printErr() {} };
      if (typeof document !== "undefined") options.locateFile = locateCharLsFile;
      charLsModulePromise = Promise.resolve(global.CharLSWASM(options)).catch((error) => {
        charLsModulePromise = null;
        throw new Error(`Could not initialize the local JPEG-LS decoder: ${codecErrorMessage(error)}`);
      });
    }
    return charLsModulePromise;
  }

  async function decodeJpegLs(record) {
    const sourceBytes = record.sourceBytes || await readSourceBytes(record.source);
    const encodedFrame = trimJpegEndPadding(extractEncapsulatedSingleFrame(record, sourceBytes));
    const charLs = await openCharLsModule();
    let decoder = null;
    try {
      decoder = new charLs.JpegLSDecoder();
      decoder.getEncodedBuffer(encodedFrame.byteLength).set(encodedFrame);
      decoder.decode();

      const frameInfo = decoder.getFrameInfo();
      const bitsPerSample = Number(frameInfo.bitsPerSample);
      const componentCount = Number(frameInfo.componentCount);
      const interleaveMode = Number(decoder.getInterleaveMode());
      const nearLossless = Number(decoder.getNearLossless());
      const expectedWidth = Number(record.columns);
      const expectedHeight = Number(record.rows);
      const expectedComponents = Number(record.samplesPerPixel || 1);
      const expectedBitsStored = Number(record.bitsStored || record.bitsAllocated);

      if (Number(frameInfo.width) !== expectedWidth || Number(frameInfo.height) !== expectedHeight) {
        throw new Error(`JPEG-LS dimensions are ${frameInfo.width}x${frameInfo.height}; expected ${expectedWidth}x${expectedHeight}.`);
      }
      if (componentCount !== expectedComponents) {
        throw new Error(`JPEG-LS frame has ${componentCount} components; expected ${expectedComponents}.`);
      }
      if (!Number.isInteger(bitsPerSample) || bitsPerSample < 2 || bitsPerSample > 16) {
        throw new Error(`JPEG-LS uses unsupported ${frameInfo.bitsPerSample}-bit samples; expected 2-16.`);
      }
      if (bitsPerSample !== expectedBitsStored) {
        throw new Error(`JPEG-LS precision is ${bitsPerSample} bits; DICOM Bits Stored is ${expectedBitsStored}.`);
      }
      if (!Number.isInteger(nearLossless) || nearLossless < 0) {
        throw new Error(`JPEG-LS returned an invalid NEAR value (${nearLossless}).`);
      }
      if (safeText(record, "transferSyntaxUID") === JPEGLS_LOSSLESS_TRANSFER_SYNTAX && nearLossless !== 0) {
        throw new Error(`JPEG-LS Lossless transfer syntax contains NEAR=${nearLossless}; expected 0.`);
      }
      if (componentCount === 3 && ![0, 1, 2].includes(interleaveMode)) {
        throw new Error(`JPEG-LS returned unsupported interleave mode ${interleaveMode}.`);
      }

      return {
        bytes: Uint8Array.from(decoder.getDecodedBuffer()),
        bitsPerSample,
        componentCount,
        interleaveMode,
        nearLossless,
      };
    } catch (error) {
      throw new Error(`Could not decode JPEG-LS frame: ${codecErrorMessage(error, charLs)}`);
    } finally {
      if (decoder && typeof decoder.delete === "function") decoder.delete();
    }
  }

  function decodeJpegLsStoredSample(raw, record, bitsPerSample) {
    const bitsStored = Number(record.bitsStored || bitsPerSample);
    const mask = (2 ** bitsStored) - 1;
    let value = raw & mask;
    if (Number(record.pixelRepresentation || 0) === 1) {
      const signBit = 2 ** (bitsStored - 1);
      if (value >= signBit) value -= 2 ** bitsStored;
    }
    return value;
  }

  function normalizeJpegLsColor(bytes, rows, columns, interleaveMode) {
    const pixelCount = rows * columns;
    const expectedBytes = pixelCount * 3;
    if (bytes.byteLength !== expectedBytes) {
      throw new Error(`JPEG-LS color payload has ${bytes.byteLength} bytes; expected ${expectedBytes}.`);
    }
    if (interleaveMode === 1 || interleaveMode === 2) return Uint8Array.from(bytes);

    const output = new Uint8Array(expectedBytes);
    if (interleaveMode === 0) {
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        output[pixel * 3] = bytes[pixel];
        output[pixel * 3 + 1] = bytes[pixelCount + pixel];
        output[pixel * 3 + 2] = bytes[pixelCount * 2 + pixel];
      }
      return output;
    }
    throw new Error(`JPEG-LS returned unsupported interleave mode ${interleaveMode}.`);
  }

  function expandColorPrecisionTo8(bytes, bitsStored) {
    if (bitsStored === 8) return bytes;
    const maximum = (2 ** bitsStored) - 1;
    const output = new Uint8Array(bytes.byteLength);
    for (let index = 0; index < bytes.byteLength; index += 1) {
      output[index] = Math.round((bytes[index] & maximum) * 255 / maximum);
    }
    return output;
  }

  function ybrFullToRgb(bytes) {
    const output = new Uint8Array(bytes.byteLength);
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    for (let index = 0; index < bytes.byteLength; index += 3) {
      const y = bytes[index];
      const cb = bytes[index + 1] - 128;
      const cr = bytes[index + 2] - 128;
      output[index] = clamp(y + 1.402 * cr);
      output[index + 1] = clamp(y - 0.344136 * cb - 0.714136 * cr);
      output[index + 2] = clamp(y + 1.772 * cb);
    }
    return output;
  }

  function scaleStoredValue(raw, record) {
    const slope = firstNumber(record.rescaleSlope, 1);
    const intercept = firstNumber(record.rescaleIntercept, 0);
    const scaled = Math.round(raw * slope + intercept);
    if (!Number.isFinite(scaled) || scaled < -32768 || scaled > 32767) {
      throw new Error(`Pixel value ${scaled} is outside the signed 16-bit range after rescale.`);
    }
    return scaled;
  }

  async function readMonochromePixels(record) {
    if (isJpegLsRecord(record)) {
      const decoded = await decodeJpegLs(record);
      const expectedPixels = Number(record.rows) * Number(record.columns);
      const bytesPerSample = decoded.bitsPerSample > 8 ? 2 : 1;
      if (decoded.bytes.byteLength !== expectedPixels * bytesPerSample) {
        throw new Error(`JPEG-LS pixel payload has ${decoded.bytes.byteLength} bytes; expected ${expectedPixels * bytesPerSample}.`);
      }
      const view = new DataView(decoded.bytes.buffer, decoded.bytes.byteOffset, decoded.bytes.byteLength);
      const output = new Int16Array(expectedPixels);
      for (let index = 0; index < expectedPixels; index += 1) {
        const raw = bytesPerSample === 2 ? view.getUint16(index * 2, true) : view.getUint8(index);
        output[index] = scaleStoredValue(decodeJpegLsStoredSample(raw, record, decoded.bitsPerSample), record);
      }
      record.jpegLsNearLossless = decoded.nearLossless;
      return output;
    }
    if (isJpeg2000Record(record)) {
      const decoded = await decodeJpeg2000(record);
      const expectedPixels = Number(record.rows) * Number(record.columns);
      const bytesPerSample = decoded.bitsPerSample > 8 ? 2 : 1;
      if (decoded.bytes.byteLength !== expectedPixels * bytesPerSample) {
        throw new Error(`JPEG 2000 pixel payload has ${decoded.bytes.byteLength} bytes; expected ${expectedPixels * bytesPerSample}.`);
      }
      const view = new DataView(decoded.bytes.buffer, decoded.bytes.byteOffset, decoded.bytes.byteLength);
      const output = new Int16Array(expectedPixels);
      for (let index = 0; index < expectedPixels; index += 1) {
        const raw = bytesPerSample === 2
          ? (decoded.isSigned ? view.getInt16(index * 2, true) : view.getUint16(index * 2, true))
          : (decoded.isSigned ? view.getInt8(index) : view.getUint8(index));
        output[index] = scaleStoredValue(raw, record);
      }
      return output;
    }
    const bytes = record.sourceBytes || await readSourceBytes(record.source);
    const bits = Number(record.bitsAllocated);
    const expectedPixels = Number(record.rows) * Number(record.columns);
    const expectedBytes = expectedPixels * (bits / 8);
    const start = Number(record.pixelOffset);
    if (start < 0 || start + expectedBytes > bytes.length || Number(record.pixelLength) < expectedBytes) {
      throw new Error("Truncated Pixel Data in a series image.");
    }

    const transferSyntax = safeText(record, "transferSyntaxUID") || EXPLICIT_VR_LITTLE_ENDIAN;
    const sourceLittleEndian = transferSyntax !== EXPLICIT_VR_BIG_ENDIAN;
    const signed = Number(record.pixelRepresentation || 0) === 1;
    const bitsStored = Number(record.bitsStored || bits);
    const highBit = Number(record.highBit ?? (bits - 1));
    if (!Number.isInteger(bitsStored) || bitsStored < 1 || bitsStored > bits) {
      throw new Error(`Invalid Bits Stored ${record.bitsStored}; expected 1-${bits}.`);
    }
    if (!Number.isInteger(highBit) || highBit < bitsStored - 1 || highBit >= bits) {
      throw new Error(`Invalid High Bit ${record.highBit}; expected ${bitsStored - 1}-${bits - 1}.`);
    }
    const rightShift = highBit + 1 - bitsStored;
    const mask = bitsStored >= 32 ? 0xffffffff : (2 ** bitsStored) - 1;
    const signBit = 2 ** (bitsStored - 1);
    const output = new Int16Array(expectedPixels);
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, expectedBytes);

    for (let index = 0; index < expectedPixels; index += 1) {
      let raw = bits === 16 ? view.getUint16(index * 2, sourceLittleEndian) : view.getUint8(index);
      raw = (raw >>> rightShift) & mask;
      if (signed && raw >= signBit) raw -= 2 ** bitsStored;
      output[index] = scaleStoredValue(raw, record);
    }
    return output;
  }

  async function readRgbPixels(record) {
    if (isJpegLsRecord(record)) {
      const decoded = await decodeJpegLs(record);
      if (decoded.bitsPerSample > 8) {
        throw new Error("JPEG-LS color input above 8-bit precision is not supported by the RGB8 package format.");
      }
      let pixels = normalizeJpegLsColor(
        decoded.bytes,
        Number(record.rows),
        Number(record.columns),
        decoded.interleaveMode,
      );
      pixels = expandColorPrecisionTo8(pixels, decoded.bitsPerSample);
      if (safeText(record, "photometricInterpretation").toUpperCase() === "YBR_FULL") {
        pixels = ybrFullToRgb(pixels);
      }
      record.jpegLsNearLossless = decoded.nearLossless;
      return pixels;
    }
    if (isJpeg2000Record(record)) {
      const decoded = await decodeJpeg2000(record);
      const expectedBytes = Number(record.rows) * Number(record.columns) * 3;
      if (decoded.bitsPerSample !== 8 || decoded.bytes.byteLength !== expectedBytes) {
        throw new Error(`JPEG 2000 RGB payload has ${decoded.bytes.byteLength} bytes; expected ${expectedBytes} 8-bit samples.`);
      }
      return decoded.bytes;
    }
    const bytes = record.sourceBytes || await readSourceBytes(record.source);
    const expectedPixels = Number(record.rows) * Number(record.columns);
    const expectedBytes = expectedPixels * 3;
    const start = Number(record.pixelOffset);
    if (start < 0 || start + expectedBytes > bytes.length || Number(record.pixelLength) < expectedBytes) {
      throw new Error("Truncated RGB Pixel Data in a series image.");
    }
    const payload = bytes.slice(start, start + expectedBytes);
    if (Number(record.planarConfiguration || 0) === 0) return payload;
    const output = new Uint8Array(expectedBytes);
    const greenOffset = expectedPixels;
    const blueOffset = expectedPixels * 2;
    for (let index = 0; index < expectedPixels; index += 1) {
      output[index * 3] = payload[index];
      output[index * 3 + 1] = payload[greenOffset + index];
      output[index * 3 + 2] = payload[blueOffset + index];
    }
    return output;
  }

  function int16LittleEndianBytes(values) {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index += 1) view.setInt16(index * 2, values[index], true);
    return bytes;
  }

  async function gzipBytes(bytes) {
    if (!("CompressionStream" in global)) {
      throw new Error("This PowerPoint WebView does not provide CompressionStream('gzip'). Use a current version or the offline Python converter.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new global.CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflateRaw(bytes) {
    if (!("DecompressionStream" in global)) {
      throw new Error("This PowerPoint WebView cannot decompress ZIP archives. Select the DICOM folder or update PowerPoint.");
    }
    let stream;
    try {
      stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream("deflate-raw"));
    } catch (error) {
      throw new Error(`Could not start ZIP decompression: ${error.message}`);
    }
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const block = 32768;
    for (let start = 0; start < bytes.length; start += block) {
      const part = bytes.subarray(start, Math.min(bytes.length, start + block));
      binary += String.fromCharCode.apply(null, part);
    }
    return global.btoa(binary);
  }

  function presetsForSeries(first, minimum, maximum) {
    const rangeWidth = Math.max(1, maximum - minimum);
    const rangeCenter = minimum + rangeWidth / 2;
    let center = firstNumber(first.windowCenter, rangeCenter);
    let width = firstNumber(first.windowWidth, rangeWidth);
    if (!Number.isFinite(center) || !Number.isFinite(width) || width < 1) {
      center = rangeCenter;
      width = rangeWidth;
    }
    const presets = { dicom: { label: "DICOM", center, width } };
    if (safeText(first, "modality").toUpperCase() === "CT") {
      Object.entries(GENERIC_CT_PRESETS).forEach(([key, value]) => {
        if (key !== "dicom") presets[key] = Object.assign({}, value);
      });
    } else {
      presets.full = { label: "Full range", center: rangeCenter, width: rangeWidth };
    }
    return { defaultWindow: { center, width }, presets };
  }

  async function convertSeries(records, options) {
    const { signal, onProgress, chunkSize, studyId, seriesId, caseId, seriesPosition, seriesTotal } = options;
    const sorted = sortSeriesRecords(records);
    records = sorted.records;
    const first = records[0];
    const rows = Number(first.rows);
    const columns = Number(first.columns);
    const samplesPerPixel = Number(first.samplesPerPixel || 1);
    const isRgb = samplesPerPixel === 3;
    const bytesPerSlice = rows * columns * (isRgb ? 3 : 2);
    const totalPixelBytes = bytesPerSlice * records.length;
    if (totalPixelBytes > MAX_PIXEL_BYTES) {
      throw new Error(`The series exceeds the ${Math.round(MAX_PIXEL_BYTES / 1024 / 1024)} MiB uncompressed pixel limit.`);
    }

    const orientation = splitNumbers(first.imageOrientationPatient);
    const spacing = splitNumbers(first.pixelSpacing);
    const positions = records.map(sliceCoordinate);
    const increments = positions.slice(1).map((value, index) => value - positions[index]);
    const sliceSpacing = sorted.sortMode === "spatial" && increments.length
      ? increments.reduce((sum, value) => sum + value, 0) / increments.length
      : firstNumber(first.spacingBetweenSlices, firstNumber(first.sliceThickness, 1));

    const chunkSpecs = [];
    const chunks = [];
    let globalMinimum = isRgb ? 255 : 32767;
    let globalMaximum = isRgb ? 0 : -32768;
    let firstSlice = 0;
    let chunkParts = [];
    let chunkByteLength = 0;

    for (let index = 0; index < records.length; index += 1) {
      abortIfRequested(signal);
      const record = records[index];
      if (Number(record.rows) !== rows || Number(record.columns) !== columns) throw new Error("The series dimensions are inconsistent.");
      if (Number(record.samplesPerPixel || 1) !== samplesPerPixel) throw new Error("Samples per Pixel is inconsistent within the series.");
      const pixels = isRgb ? await readRgbPixels(record) : await readMonochromePixels(record);
      const bytes = isRgb ? pixels : int16LittleEndianBytes(pixels);
      for (const value of pixels) {
        if (value < globalMinimum) globalMinimum = value;
        if (value > globalMaximum) globalMaximum = value;
      }
      chunkParts.push(bytes);
      chunkByteLength += bytes.byteLength;

      report(
        onProgress,
        "convert",
        0.25 + 0.68 * ((seriesPosition + (index + 1) / records.length) / seriesTotal),
        `Converting series ${seriesPosition + 1}/${seriesTotal}: image ${index + 1}/${records.length}`,
        { seriesIndex: seriesPosition, seriesTotal, imageIndex: index, imageTotal: records.length }
      );
      if (index % 2 === 1) await yieldToUi();

      const isLast = index === records.length - 1;
      if (chunkParts.length >= chunkSize || isLast) {
        const raw = new Uint8Array(chunkByteLength);
        let writeOffset = 0;
        chunkParts.forEach((part) => {
          raw.set(part, writeOffset);
          writeOffset += part.byteLength;
        });
        const compressed = await gzipBytes(raw);
        const chunkIndex = chunks.length;
        const sliceCount = index - firstSlice + 1;
        chunks.push(bytesToBase64(compressed));
        chunkSpecs.push({
          index: chunkIndex,
          firstSlice,
          sliceCount,
          script: `chunks/chunk-${String(chunkIndex).padStart(3, "0")}.js`,
          compressedBytes: compressed.byteLength,
          uncompressedBytes: raw.byteLength,
        });
        firstSlice = index + 1;
        chunkParts = [];
        chunkByteLength = 0;
      }
    }

    let { defaultWindow, presets } = presetsForSeries(first, globalMinimum, globalMaximum);
    if (isRgb) {
      defaultWindow = { center: 127.5, width: 255 };
      presets = {};
    }

    const manifest = {
      format: "dicom-slide-volume/1",
      caseId,
      title: safeText(first, "seriesDescription") || `Series ${safeText(first, "seriesNumber") || seriesPosition + 1}`,
      modality: safeText(first, "modality"),
      dimensions: { columns, rows, slices: records.length },
      spacing: {
        column: spacing.length > 1 ? spacing[1] : 1,
        row: spacing.length ? spacing[0] : 1,
        slice: Math.abs(sliceSpacing || 1),
      },
      orientationLPS: orientation.length >= 6 ? orientation.slice(0, 6) : [1, 0, 0, 0, 1, 0],
      sliceCoordinates: sorted.sortMode === "spatial" ? positions.map((value) => Math.round(value * 1e6) / 1e6) : null,
      sortMode: sorted.sortMode,
      pixelType: isRgb ? "rgb8" : "int16-le",
      samplesPerPixel,
      units: isRgb ? "RGB" : (safeText(first, "modality").toUpperCase() === "CT" ? "HU" : "stored units"),
      invert: !isRgb && safeText(first, "photometricInterpretation").toUpperCase() === "MONOCHROME1",
      valueRange: { minimum: globalMinimum, maximum: globalMaximum },
      initialSlice: Math.floor(records.length / 2),
      defaultWindow,
      presets,
      chunks: chunkSpecs,
      source: {
        importedLocally: true,
        studyDescription: safeText(first, "studyDescription"),
        seriesDescription: safeText(first, "seriesDescription"),
        seriesNumber: safeText(first, "seriesNumber"),
        transferSyntaxUID: Array.from(new Set(records.map((item) => safeText(item, "transferSyntaxUID")))).filter(Boolean).join(", "),
        jpegLsNearLossless: records.some((item) => Number.isFinite(item.jpegLsNearLossless))
          ? Math.max(...records.map((item) => Number(item.jpegLsNearLossless || 0)))
          : null,
      },
    };
    manifest.baseUrl = `${LOCAL_PROTOCOL}//${studyId}/series/${seriesId}/`;
    return { manifest, chunks, totalPixelBytes };
  }

  function sourceFromFile(file) {
    const name = file.webkitRelativePath || file.name || "DICOM";
    return {
      name,
      size: Number(file.size || 0),
      async read() {
        return new Uint8Array(await file.arrayBuffer());
      },
    };
  }

  function readZipString(bytes, utf8) {
    try {
      return new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(bytes);
    } catch (_) {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  function findEndOfCentralDirectory(bytes) {
    const minimum = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
      if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
    }
    return -1;
  }

  async function zipSourcesFromFile(file, options = {}) {
    const { signal, onProgress } = options;
    abortIfRequested(signal);
    const archive = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const eocd = findEndOfCentralDirectory(archive);
    if (eocd < 0) throw new Error(`${file.name}: ZIP central directory not found.`);
    const entryCount = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (entryCount === 0xffff || centralOffset === 0xffffffff) throw new Error("ZIP64 is not supported by the PowerPoint importer yet.");

    const entries = [];
    let offset = centralOffset;
    let expandedBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      abortIfRequested(signal);
      if (offset + 46 > archive.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error(`${file.name}: invalid ZIP central directory.`);
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new Error("ZIP64 is not supported by the PowerPoint importer yet.");
      }
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
      const name = readZipString(nameBytes, Boolean(flags & 0x0800));
      offset += 46 + nameLength + extraLength + commentLength;

      if (!name || name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)\._/.test(name)) continue;
      if (flags & 0x0001) throw new Error(`${name}: encrypted ZIP entries are not supported.`);
      if (![0, 8].includes(method)) throw new Error(`${name}: ZIP method ${method} is not supported.`);
      if (localOffset + 30 > archive.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${name}: invalid local ZIP header.`);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > archive.length) throw new Error(`${name}: truncated ZIP content.`);
      expandedBytes += uncompressedSize;
      if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`The ZIP archive exceeds ${Math.round(MAX_EXPANDED_BYTES / 1024 / 1024)} MiB after decompression.`);

      entries.push({
        name,
        size: uncompressedSize,
        async read() {
          abortIfRequested(signal);
          const compressed = archive.slice(dataOffset, dataOffset + compressedSize);
          const output = method === 0 ? compressed : await inflateRaw(compressed);
          if (output.byteLength !== uncompressedSize) throw new Error(`${name}: decompressed size does not match the ZIP entry.`);
          return output;
        },
      });
      report(onProgress, "unzip", (index + 1) / entryCount * 0.08, `Indexing ZIP: ${index + 1}/${entryCount}`);
    }
    return entries;
  }

  async function expandInputFiles(files, options = {}) {
    const sources = [];
    for (const file of files) {
      abortIfRequested(options.signal);
      const isZip = /\.zip$/i.test(file.name || "") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
      if (isZip) sources.push(...await zipSourcesFromFile(file, options));
      else sources.push(sourceFromFile(file));
      if (sources.length > MAX_INPUT_FILES) throw new Error(`The import exceeds the limit of ${MAX_INPUT_FILES} files.`);
    }
    if (!sources.length) throw new Error("No files were selected.");
    const total = sources.reduce((sum, source) => sum + Number(source.size || 0), 0);
    if (total > MAX_EXPANDED_BYTES) throw new Error(`The selection exceeds ${Math.round(MAX_EXPANDED_BYTES / 1024 / 1024)} MiB.`);
    return sources;
  }

  function seriesSortKey(records) {
    const first = records[0];
    return [firstNumber(first.seriesNumber, Number.MAX_SAFE_INTEGER), safeText(first, "seriesDescription").toLowerCase(), safeText(first, "seriesInstanceUID")];
  }

  function compareSeries(left, right) {
    const a = seriesSortKey(left[1]);
    const b = seriesSortKey(right[1]);
    return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
  }

  async function importFiles(inputFiles, options = {}) {
    const files = Array.from(inputFiles || []);
    const signal = options.signal;
    const onProgress = options.onProgress;
    const chunkSize = Math.max(1, Math.round(Number(options.chunkSize || DEFAULT_CHUNK_SIZE)));
    abortIfRequested(signal);
    report(onProgress, "prepare", 0, "Preparing files for import…");

    const sources = await expandInputFiles(files, { signal, onProgress });
    const headers = [];
    const scanErrors = [];
    for (let index = 0; index < sources.length; index += 1) {
      abortIfRequested(signal);
      const source = sources[index];
      try {
        const bytes = await readSourceBytes(source);
        const meta = parseDicomBuffer(bytes, source.name, false);
        meta.source = source;
        meta.sourceBytes = bytes;
        headers.push(meta);
      } catch (error) {
        scanErrors.push(`${source.name}: ${error.message}`);
      }
      report(onProgress, "scan", 0.08 + (index + 1) / sources.length * 0.17, `Reading DICOM headers: ${index + 1}/${sources.length}`);
      if (index % 8 === 7) await yieldToUi();
    }
    if (!headers.length) {
      throw new Error(`No compatible DICOM images were found.${scanErrors.length ? `\n${scanErrors.slice(0, 5).join("\n")}` : ""}`);
    }

    const studyCounts = new Map();
    headers.forEach((record) => {
      const uid = safeText(record, "studyInstanceUID") || "unknown";
      studyCounts.set(uid, (studyCounts.get(uid) || 0) + 1);
    });
    if (studyCounts.size !== 1) {
      const counts = Array.from(studyCounts.entries()).map(([uid, count]) => `${uid}: ${count}`).join(", ");
      throw new Error(`The selection contains multiple Study Instance UIDs (${counts}). Import one study at a time.`);
    }

    const grouped = new Map();
    headers.forEach((record) => {
      const uid = safeText(record, "seriesInstanceUID") || "unknown";
      if (!grouped.has(uid)) grouped.set(uid, []);
      grouped.get(uid).push(record);
    });

    const firstHeader = headers[0];
    const studyUid = Array.from(studyCounts.keys())[0];
    const identity = studyUid !== "unknown"
      ? studyUid
      : headers.map((item) => `${item.sourceName}:${item.rows}x${item.columns}:${safeText(item, "seriesInstanceUID")}`).sort().join("|");
    const studyHash = await shortHash(identity, 12);
    const studyTitle = safeText(firstHeader, "studyDescription") || "Imported DICOM study";
    const studyId = `local-${slugify(studyTitle, "dicom-study")}-${studyHash}`;
    const warnings = [];
    const conversionFailures = [];
    if (scanErrors.length) warnings.push(`${scanErrors.length} non-DICOM or incomplete file(s) were ignored.`);

    const phiTagsDetected = headers.some((record) => ["patientName", "patientID", "accessionNumber", "institutionName"].some((key) => Boolean(safeText(record, key))));
    const burnedInAnnotation = headers.some((record) => safeText(record, "burnedInAnnotation").toUpperCase() === "YES");
    if (phiTagsDetected) warnings.push("Identifying metadata was detected and was not stored in the converted package.");
    if (burnedInAnnotation) warnings.push("Burned In Annotation = YES in at least one image; review the pixels before sharing.");

    const seriesEntries = [];
    const manifests = {};
    const chunkPayloads = {};
    let totalCompressedBytes = 0;
    let totalPixelBytes = 0;
    const groupedEntries = Array.from(grouped.entries()).sort(compareSeries);

    for (let position = 0; position < groupedEntries.length; position += 1) {
      abortIfRequested(signal);
      const [seriesUid, records] = groupedEntries[position];
      const reasons = Array.from(new Set(records.map(supportedRecordReason).filter(Boolean)));
      if (reasons.length) {
        const description = safeText(records[0], "seriesDescription") || safeText(records[0], "seriesNumber") || String(position + 1);
        const failure = `Series ${description} skipped: ${reasons.join("; ")}.`;
        warnings.push(failure);
        conversionFailures.push(failure);
        continue;
      }
      const first = records[0];
      const numberText = safeText(first, "seriesNumber") || String(position + 1);
      const description = safeText(first, "seriesDescription") || `Series ${numberText}`;
      const uidHash = await shortHash(seriesUid, 7);
      const seriesId = `series-${slugify(numberText, String(position + 1))}-${slugify(description, "no-description")}-${uidHash}`;
      const caseId = `${studyId}--${seriesId}`;
      try {
        const converted = await convertSeries(records, {
          signal,
          onProgress,
          chunkSize,
          studyId,
          seriesId,
          caseId,
          seriesPosition: position,
          seriesTotal: groupedEntries.length,
        });
        manifests[caseId] = converted.manifest;
        chunkPayloads[caseId] = converted.chunks;
        totalPixelBytes += converted.totalPixelBytes;
        totalCompressedBytes += converted.manifest.chunks.reduce((sum, item) => sum + item.compressedBytes, 0);
        seriesEntries.push({
          id: seriesId,
          caseId,
          number: numberText,
          title: description,
          modality: converted.manifest.modality,
          slices: converted.manifest.dimensions.slices,
          rows: converted.manifest.dimensions.rows,
          columns: converted.manifest.dimensions.columns,
          sortMode: converted.manifest.sortMode,
          manifest: `series/${seriesId}/manifest.js`,
        });
      } catch (error) {
        const failure = `Series ${description} skipped: ${error.message}`;
        warnings.push(failure);
        conversionFailures.push(failure);
      }
    }

    if (!seriesEntries.length) {
      throw new Error(`No series could be converted. ${conversionFailures.join(" ")}`);
    }

    const study = {
      format: "dicom-slide-study/1",
      studyId,
      title: studyTitle,
      studyInstanceUID: studyUid,
      seriesCount: seriesEntries.length,
      series: seriesEntries,
      source: {
        importedLocally: true,
        dicomFileCount: headers.length,
        selectedFileCount: sources.length,
        ignoredFileCount: scanErrors.length,
        phiTagsRemoved: phiTagsDetected,
        burnedInAnnotation,
      },
    };
    study.baseUrl = `${LOCAL_PROTOCOL}//${studyId}/`;

    const packageRecord = {
      id: studyId,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      study,
      manifests,
      chunks: chunkPayloads,
      warnings,
      totalCompressedBytes,
      totalPixelBytes,
    };

    report(onProgress, "persist", 0.96, options.persist === false
      ? "Finalizing the converted study…"
      : "Writing the converted study to the local cache…");
    const persisted = options.persist === false ? false : await storePackage(packageRecord);
    if (options.register !== false) await registerPackage(packageRecord);
    report(onProgress, "complete", 1, `Import complete: ${seriesEntries.length} series, ${headers.length} images.`);
    return { package: packageRecord, study, warnings, persisted, totalCompressedBytes, totalPixelBytes };
  }

  function localStudyUrl(studyId) {
    return `${LOCAL_PROTOCOL}//${String(studyId).replace(/[^a-z0-9-]/gi, "-").toLowerCase()}/study.js`;
  }

  function isLocalStudyUrl(value) {
    try {
      return new URL(String(value)).protocol === LOCAL_PROTOCOL;
    } catch (_) {
      return false;
    }
  }

  function studyIdFromLocalUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === LOCAL_PROTOCOL ? url.hostname : null;
    } catch (_) {
      return null;
    }
  }

  async function registerPackage(packageRecord) {
    if (!packageRecord?.study?.studyId) throw new Error("Invalid local package.");
    if (global.DicomSlide?.ready) await global.DicomSlide.ready;
    const dataApi = global.DicomSlideData;
    if (!dataApi?.registerManifest || !dataApi?.registerChunk) throw new Error("The DICOM Slides runtime is not available yet.");

    const study = Object.assign({}, packageRecord.study, { baseUrl: `${LOCAL_PROTOCOL}//${packageRecord.study.studyId}/` });
    const registry = global.__DICOM_SLIDE_STUDIES__ || (global.__DICOM_SLIDE_STUDIES__ = {});
    registry[study.studyId] = study;

    Object.entries(packageRecord.manifests || {}).forEach(([caseId, storedManifest]) => {
      const series = study.series.find((item) => item.caseId === caseId);
      const baseUrl = `${LOCAL_PROTOCOL}//${study.studyId}/series/${series?.id || caseId}/`;
      dataApi.registerManifest(caseId, Object.assign({}, storedManifest, { baseUrl }));
      const chunks = packageRecord.chunks?.[caseId] || [];
      chunks.forEach((encoded, index) => dataApi.registerChunk(caseId, index, encoded));
    });
    return study;
  }

  async function ensureRegistered(studyId) {
    if (global.__DICOM_SLIDE_STUDIES__?.[studyId]) return global.__DICOM_SLIDE_STUDIES__[studyId];
    const packageRecord = await loadPackage(studyId);
    if (!packageRecord) {
      throw new Error("This study was imported locally, but it is not in this device and profile's cache. Import the DICOM files again.");
    }
    return registerPackage(packageRecord);
  }

  function openDatabase() {
    if (!("indexedDB" in global) || !global.indexedDB) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PACKAGE_STORE)) database.createObjectStore(PACKAGE_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open IndexedDB."));
      request.onblocked = () => reject(new Error("The local cache is blocked by another window."));
    });
  }

  function runTransaction(database, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(PACKAGE_STORE, mode);
      const store = transaction.objectStore(PACKAGE_STORE);
      let request;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error || request?.error || new Error("Local cache failure."));
      transaction.onabort = () => reject(transaction.error || new Error("Cache operation canceled."));
    });
  }

  async function storePackage(packageRecord) {
    try {
      const database = await databaseReady;
      if (!database) return false;
      await runTransaction(database, "readwrite", (store) => store.put(packageRecord));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function loadPackage(studyId) {
    try {
      const database = await databaseReady;
      if (!database) return null;
      return await runTransaction(database, "readonly", (store) => store.get(studyId)) || null;
    } catch (_) {
      return null;
    }
  }

  async function deletePackage(studyId) {
    try {
      const database = await databaseReady;
      if (!database) return false;
      await runTransaction(database, "readwrite", (store) => store.delete(studyId));
      return true;
    } catch (_) {
      return false;
    }
  }

  const api = {
    version: "1.0.0",
    ready: databaseReady.then(() => undefined),
    importFiles,
    registerPackage,
    ensureRegistered,
    storePackage,
    loadPackage,
    deletePackage,
    localStudyUrl,
    isLocalStudyUrl,
    studyIdFromLocalUrl,
    testing: Object.freeze({
      parseDicomBuffer,
      supportedRecordReason,
      sortSeriesRecords,
      normalizeJpegLsColor,
      expandColorPrecisionTo8,
      ybrFullToRgb,
      zipSourcesFromFile,
      bytesToBase64,
      int16LittleEndianBytes,
    }),
  };

  global.DicomSlidesImporter = Object.freeze(api);
})(typeof window !== "undefined" ? window : globalThis);
