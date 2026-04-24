// Export Worker - page post-processing and XTG/XTH encoding off the main thread

self.onmessage = function(e) {
    var data = e.data;

    try {
        var rgba = new Uint8ClampedArray(data.imageData);
        var imageData = {
            data: rgba,
            width: data.width,
            height: data.height
        };
        var pageData = processRenderedPage(imageData, data.isHQ, data.options);

        self.postMessage({
            id: data.id,
            pageNum: data.pageNum,
            pageData: pageData.buffer
        }, [pageData.buffer]);
    } catch (err) {
        self.postMessage({
            id: data.id,
            error: err && err.message ? err.message : String(err)
        });
    }
};

function processRenderedPage(imageData, isHQ, options) {
    var bits = isHQ ? 2 : 1;

    if (options.enableDithering) {
        imageData = applyDitheringSync(imageData, bits, options.ditherStrength);
    }

    if (options.enableNegative) {
        applyNegative(imageData);
    }

    return isHQ ? encodeXTH(imageData) : encodeXTG(imageData);
}

function applyDitheringSync(imageData, bits, strength) {
    var data = imageData.data;
    var width = imageData.width;
    var height = imageData.height;
    var gray = new Float32Array(width * height);

    for (var i = 0; i < width * height; i++) {
        var idx = i * 4;
        gray[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }

    for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
            var grayIdx = y * width + x;
            var oldPixel = gray[grayIdx];
            var newPixel = quantize(oldPixel, bits);
            gray[grayIdx] = newPixel;

            var error = (oldPixel - newPixel) * strength;

            if (x + 1 < width) gray[grayIdx + 1] += error * 7 / 16;
            if (y + 1 < height) {
                if (x > 0) gray[grayIdx + width - 1] += error * 3 / 16;
                gray[grayIdx + width] += error * 5 / 16;
                if (x + 1 < width) gray[grayIdx + width + 1] += error * 1 / 16;
            }
        }
    }

    for (var j = 0; j < width * height; j++) {
        var v = Math.max(0, Math.min(255, Math.round(gray[j])));
        var outIdx = j * 4;
        data[outIdx] = v;
        data[outIdx + 1] = v;
        data[outIdx + 2] = v;
    }

    return imageData;
}

function quantize(value, bits) {
    if (bits === 1) {
        return value < 128 ? 0 : 255;
    }

    if (value > 212) return 255;
    if (value > 127) return 170;
    if (value > 42) return 85;
    return 0;
}

function applyNegative(imageData) {
    var data = imageData.data;
    for (var i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
    }
}

function encodeXTG(imageData) {
    var width = imageData.width;
    var height = imageData.height;
    var data = imageData.data;
    var header = new Uint8Array(22);
    var view = new DataView(header.buffer);

    header[0] = 0x58;
    header[1] = 0x54;
    header[2] = 0x47;
    header[3] = 0x00;
    view.setUint16(4, width, true);
    view.setUint16(6, height, true);
    header[8] = 0;
    header[9] = 0;

    var rowBytes = Math.ceil(width / 8);
    var dataSize = rowBytes * height;
    view.setUint32(10, dataSize, true);
    var bitmap = new Uint8Array(rowBytes * height);

    for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
            var srcIdx = (y * width + x) * 4;
            var gray = data[srcIdx];

            if (gray >= 128) {
                var byteIdx = y * rowBytes + Math.floor(x / 8);
                var bitIdx = 7 - (x % 8);
                bitmap[byteIdx] |= (1 << bitIdx);
            }
        }
    }

    var result = new Uint8Array(header.length + bitmap.length);
    result.set(header, 0);
    result.set(bitmap, header.length);
    return result;
}

function encodeXTH(imageData) {
    var width = imageData.width;
    var height = imageData.height;
    var data = imageData.data;
    var header = new Uint8Array(22);
    var view = new DataView(header.buffer);

    header[0] = 0x58;
    header[1] = 0x54;
    header[2] = 0x48;
    header[3] = 0x00;
    view.setUint16(4, width, true);
    view.setUint16(6, height, true);
    header[8] = 0;
    header[9] = 0;

    var colBytes = Math.ceil(height / 8);
    var dataSize = colBytes * width * 2;
    view.setUint32(10, dataSize, true);
    var plane0 = new Uint8Array(colBytes * width);
    var plane1 = new Uint8Array(colBytes * width);

    for (var x = width - 1; x >= 0; x--) {
        var colIdx = width - 1 - x;

        for (var y = 0; y < height; y++) {
            var srcIdx = (y * width + x) * 4;
            var gray = data[srcIdx];
            var level;

            if (gray > 212) level = 0b00;
            else if (gray > 127) level = 0b10;
            else if (gray > 42) level = 0b01;
            else level = 0b11;

            var byteIdx = colIdx * colBytes + Math.floor(y / 8);
            var bitIdx = 7 - (y % 8);

            if (level & 0b01) plane0[byteIdx] |= (1 << bitIdx);
            if (level & 0b10) plane1[byteIdx] |= (1 << bitIdx);
        }
    }

    var result = new Uint8Array(header.length + plane0.length + plane1.length);
    result.set(header, 0);
    result.set(plane0, header.length);
    result.set(plane1, header.length + plane0.length);
    return result;
}
