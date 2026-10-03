#!/usr/bin/env python3
"""Generate Chrome Web Store Promo Tiles for AutoZoom.

Outputs:
  store-assets/promo-small.png            (440x280, Logo + "AutoZoom" + subtitle)
  store-assets/promo-small-minimal.png    (440x280, Logo + "AutoZoom" only)
  store-assets/promo-marquee.png          (1400x560, Brand + dual-display illustration)
  store-assets/promo-marquee-minimal.png  (1400x560, Centered Logo + "AutoZoom" + subtitle)

Uses macOS AppKit via JXA (instant startup, native SF Pro typography)
and writes strict 24-bit RGB PNGs (no alpha).
"""
import os
import subprocess
import sys

JXA_SCRIPT = r"""
ObjC.import('AppKit');
ObjC.import('Foundation');

function rgba(r, g, b, a) {
    return $.NSColor.colorWithCalibratedRedGreenBlueAlpha(r / 255.0, g / 255.0, b / 255.0, a);
}

function drawAppIcon(ctx, iconX, iconY, iconSize, shadowDy, shadowBlur) {
    const corner = iconSize * 0.234;
    const iconRect = $.NSMakeRect(iconX, iconY, iconSize, iconSize);
    const iconPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(iconRect, corner, corner);

    ctx.saveGraphicsState;
    const shadow = $.NSShadow.alloc.init;
    shadow.setShadowOffset($.NSMakeSize(0, shadowDy));
    shadow.setShadowBlurRadius(shadowBlur);
    shadow.setShadowColor($.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.039, 0.369, 0.839, 0.24));
    shadow.set;
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.039, 0.369, 0.839, 1.0).setFill;
    iconPath.fill;
    ctx.restoreGraphicsState;

    const iconTop = rgba(0x3A, 0x9B, 0xFF, 1.0);
    const iconBot = rgba(0x0A, 0x5E, 0xD6, 1.0);
    const iconGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(iconBot, iconTop);
    iconGrad.drawInBezierPathAngle(iconPath, 90.0);

    ctx.saveGraphicsState;
    iconPath.addClip;
    $.NSColor.whiteColor.setStroke;

    const lensCx = iconX + iconSize * 0.436;
    const lensCy = iconY + iconSize * (1.0 - 0.436);
    const lensR = iconSize * 0.234;
    const ringW = iconSize * 0.0585;
    const plusLen = lensR * 0.55;
    const plusW = iconSize * 0.048;
    const handleW = iconSize * 0.080;

    const ringPath = $.NSBezierPath.bezierPathWithOvalInRect(
        $.NSMakeRect(lensCx - lensR, lensCy - lensR, lensR * 2.0, lensR * 2.0)
    );
    ringPath.setLineWidth(ringW);
    ringPath.stroke;

    const plusPath = $.NSBezierPath.bezierPath;
    plusPath.setLineCapStyle($.NSLineCapStyleRound);
    plusPath.setLineWidth(plusW);
    plusPath.moveToPoint($.NSMakePoint(lensCx - plusLen, lensCy));
    plusPath.lineToPoint($.NSMakePoint(lensCx + plusLen, lensCy));
    plusPath.moveToPoint($.NSMakePoint(lensCx, lensCy - plusLen));
    plusPath.lineToPoint($.NSMakePoint(lensCx, lensCy + plusLen));
    plusPath.stroke;

    const diag = Math.SQRT1_2;
    const hx0 = lensCx + lensR * diag + ringW * 0.2;
    const hy0 = lensCy - lensR * diag - ringW * 0.2;
    const hx1 = iconX + iconSize * 0.819;
    const hy1 = iconY + iconSize * (1.0 - 0.819);

    const handlePath = $.NSBezierPath.bezierPath;
    handlePath.setLineCapStyle($.NSLineCapStyleRound);
    handlePath.setLineWidth(handleW);
    handlePath.moveToPoint($.NSMakePoint(hx0, hy0));
    handlePath.lineToPoint($.NSMakePoint(hx1, hy1));
    handlePath.stroke;
    ctx.restoreGraphicsState;
}

function makeTextAttrs(size, weight, color, kern) {
    const attrs = $.NSMutableDictionary.dictionary;
    attrs.setObjectForKey($.NSFont.systemFontOfSizeWeight(size, weight), $.NSFontAttributeName);
    attrs.setObjectForKey(color, $.NSForegroundColorAttributeName);
    if (kern !== undefined && kern !== 0) {
        attrs.setObjectForKey($(kern), $.NSKernAttributeName);
    }
    return attrs;
}

function drawText(text, x, y, attrs) {
    const str = $.NSString.stringWithString(text);
    str.drawAtPointWithAttributes($.NSMakePoint(x, y), attrs);
    return str.sizeWithAttributes(attrs);
}

function measureText(text, attrs) {
    const str = $.NSString.stringWithString(text);
    return str.sizeWithAttributes(attrs);
}

function makeSmallPromo(outputPath, subtitle) {
    const w = 440;
    const h = 280;

    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
    );
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.setCurrentContext(ctx);

    const fullRect = $.NSMakeRect(0, 0, w, h);

    const bgTop = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.973, 0.980, 0.996, 1.0);
    const bgBottom = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.910, 0.945, 0.992, 1.0);
    const bgGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(bgBottom, bgTop);
    bgGrad.drawInRectAngle(fullRect, 90.0);

    const iconSize = 92.0;
    const iconX = (w - iconSize) / 2.0;
    const iconY = subtitle ? 132.0 : 120.0;
    const glowCenter = $.NSMakePoint(w / 2.0, iconY + iconSize / 2.0);
    const glowInner = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.039, 0.518, 1.0, 0.12);
    const glowOuter = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.039, 0.518, 1.0, 0.0);
    const glowGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(glowInner, glowOuter);
    glowGrad.drawFromCenterRadiusToCenterRadiusOptions(glowCenter, 0.0, glowCenter, 150.0, 0);

    drawAppIcon(ctx, iconX, iconY, iconSize, -7, 18.0);

    const titleAttrs = makeTextAttrs(30.0, $.NSFontWeightBold, $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.114, 0.114, 0.122, 1.0), -0.6);
    const titleSize = measureText("AutoZoom", titleAttrs);
    const titleY = subtitle ? 76.0 : 62.0;
    drawText("AutoZoom", (w - titleSize.width) / 2.0, titleY, titleAttrs);

    if (subtitle) {
        const subAttrs = makeTextAttrs(14.5, $.NSFontWeightMedium, $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.36, 0.40, 0.48, 1.0), -0.1);
        const subSize = measureText(subtitle, subAttrs);
        drawText(subtitle, (w - subSize.width) / 2.0, 48.0, subAttrs);
    }

    const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    pngData.writeToFileAtomically($(outputPath), true);
}

function makeMarqueeMinimal(outputPath) {
    const w = 1400;
    const h = 560;

    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
    );
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.setCurrentContext(ctx);

    const fullRect = $.NSMakeRect(0, 0, w, h);
    const bgTop = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.973, 0.980, 0.996, 1.0);
    const bgBottom = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.910, 0.945, 0.992, 1.0);
    const bgGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(bgBottom, bgTop);
    bgGrad.drawInRectAngle(fullRect, 90.0);

    const iconSize = 180.0;
    const iconX = (w - iconSize) / 2.0;
    const iconY = 266.0;
    const glowCenter = $.NSMakePoint(w / 2.0, iconY + iconSize / 2.0);
    const glowInner = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.039, 0.518, 1.0, 0.14);
    const glowOuter = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.039, 0.518, 1.0, 0.0);
    const glowGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(glowInner, glowOuter);
    glowGrad.drawFromCenterRadiusToCenterRadiusOptions(glowCenter, 0.0, glowCenter, 320.0, 0);

    drawAppIcon(ctx, iconX, iconY, iconSize, -12, 32.0);

    const titleAttrs = makeTextAttrs(58.0, $.NSFontWeightBold, rgba(29, 29, 31, 1.0), -1.2);
    const titleSize = measureText("AutoZoom", titleAttrs);
    drawText("AutoZoom", (w - titleSize.width) / 2.0, 156.0, titleAttrs);

    const subAttrs = makeTextAttrs(27.0, $.NSFontWeightMedium, rgba(92, 102, 122, 1.0), -0.2);
    const subSize = measureText("Per-Monitor Automatic Zoom", subAttrs);
    drawText("Per-Monitor Automatic Zoom", (w - subSize.width) / 2.0, 104.0, subAttrs);

    const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    pngData.writeToFileAtomically($(outputPath), true);
}

function drawBrowserWindow(ctx, x, y, w, h, scale, badgeText, urlText, isActiveAccent) {
    // Window card with soft drop shadow
    const winRadius = 10.0 * scale;
    const winRect = $.NSMakeRect(x, y, w, h);
    const winPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(winRect, winRadius, winRadius);

    ctx.saveGraphicsState;
    const sh = $.NSShadow.alloc.init;
    sh.setShadowOffset($.NSMakeSize(0, -6 * scale));
    sh.setShadowBlurRadius(16.0 * scale);
    sh.setShadowColor(rgba(15, 35, 70, 0.16));
    sh.set;
    $.NSColor.whiteColor.setFill;
    winPath.fill;
    ctx.restoreGraphicsState;

    ctx.saveGraphicsState;
    winPath.addClip;

    // Top toolbar bar
    const barH = Math.round(28.0 * scale);
    const barY = y + h - barH;
    rgba(244, 246, 250, 1.0).setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(x, barY, w, barH));

    // Toolbar bottom divider
    rgba(226, 232, 240, 1.0).setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(x, barY, w, 1.0));

    // Traffic lights
    const dotR = 3.6 * scale;
    const dotCy = barY + barH / 2.0;
    const colors = [rgba(255, 95, 87, 1.0), rgba(254, 188, 46, 1.0), rgba(40, 200, 64, 1.0)];
    for (let i = 0; i < 3; i++) {
        const dotCx = x + (13.0 + i * 11.5) * scale;
        colors[i].setFill;
        $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(dotCx - dotR, dotCy - dotR, dotR * 2, dotR * 2)).fill;
    }

    // Address bar pill
    const addrX = x + 52.0 * scale;
    const addrH = 16.0 * scale;
    const addrY = barY + (barH - addrH) / 2.0;
    const addrW = w - 98.0 * scale;
    const addrPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(addrX, addrY, addrW, addrH), addrH / 2.0, addrH / 2.0
    );
    $.NSColor.whiteColor.setFill;
    addrPath.fill;
    rgba(218, 224, 235, 1.0).setStroke;
    addrPath.setLineWidth(1.0);
    addrPath.stroke;

    if (urlText) {
        const uAttrs = makeTextAttrs(8.5 * scale, $.NSFontWeightMedium, rgba(110, 118, 135, 1.0), 0);
        const uSize = measureText(urlText, uAttrs);
        drawText(urlText, addrX + 9.0 * scale, addrY + (addrH - uSize.height) / 2.0 + 0.5, uAttrs);
    }

    // Extension badge pill on right of toolbar
    const badgeW = 32.0 * scale;
    const badgeH = 16.0 * scale;
    const badgeX = x + w - badgeW - 8.0 * scale;
    const badgeY = barY + (barH - badgeH) / 2.0;
    const badgePath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(badgeX, badgeY, badgeW, badgeH), 4.5 * scale, 4.5 * scale
    );
    (isActiveAccent ? rgba(10, 132, 255, 1.0) : rgba(71, 85, 105, 1.0)).setFill;
    badgePath.fill;

    const bAttrs = makeTextAttrs(9.5 * scale, $.NSFontWeightBold, $.NSColor.whiteColor, 0);
    const bSize = measureText(badgeText, bAttrs);
    drawText(badgeText, badgeX + (badgeW - bSize.width) / 2.0, badgeY + (badgeH - bSize.height) / 2.0 + 0.5, bAttrs);

    // Page content area (scaled by `scale` to visually demonstrate 100% vs 125% zoom!)
    const padX = x + 18.0 * scale;
    const contentTop = barY - 16.0 * scale;

    // Eyebrow tag in page
    const tagW = 46.0 * scale;
    const tagH = 8.0 * scale;
    const tagRect = $.NSMakeRect(padX, contentTop - tagH, tagW, tagH);
    rgba(10, 132, 255, 0.18).setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(tagRect, tagH / 2.0, tagH / 2.0).fill;

    // Big "Aa" + Headline bar to make the zoom scale unmistakable
    const aaAttrs = makeTextAttrs(22.0 * scale, $.NSFontWeightBold, rgba(29, 29, 31, 1.0), -0.5);
    const aaY = contentTop - tagH - 30.0 * scale;
    const aaSize = drawText("Aa", padX, aaY, aaAttrs);

    const hBarX = padX + aaSize.width + 10.0 * scale;
    const hBarW = Math.min(w - (hBarX - x) - 18.0 * scale, 145.0 * scale);
    const hBarH = 10.0 * scale;
    const hBarY = aaY + 9.0 * scale;
    rgba(30, 41, 59, 0.88).setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(hBarX, hBarY, hBarW, hBarH), 4.0 * scale, 4.0 * scale).fill;

    // Sub-bar under headline
    const hBar2W = hBarW * 0.65;
    const hBar2H = 6.5 * scale;
    const hBar2Y = aaY + 0.5 * scale;
    rgba(100, 116, 139, 0.45).setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(hBarX, hBar2Y, hBar2W, hBar2H), 3.0 * scale, 3.0 * scale).fill;

    // Paragraph lines + feature card inside page
    const lineStartY = aaY - 16.0 * scale;
    const lineH = 6.5 * scale;
    const lineGap = 12.5 * scale;
    const maxLineW = w - 36.0 * scale;
    const lineWidths = [0.95, 0.86, 0.72];

    for (let i = 0; i < lineWidths.length; i++) {
        const ly = lineStartY - i * lineGap;
        if (ly < y + 12.0 * scale) break;
        rgba(148, 163, 184, 0.48).setFill;
        const lw = maxLineW * lineWidths[i];
        $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
            $.NSMakeRect(padX, ly, lw, lineH), lineH / 2.0, lineH / 2.0
        ).fill;
    }

    ctx.restoreGraphicsState;
}

function drawFeatureChip(ctx, x, y, text) {
    const textAttrs = makeTextAttrs(14.5, $.NSFontWeightSemibold, rgba(30, 58, 108, 1.0), -0.1);
    const tSize = measureText(text, textAttrs);
    const dotSize = 7.0;
    const padL = 14.0;
    const gap = 8.0;
    const padR = 15.0;
    const chipH = 34.0;
    const chipW = padL + dotSize + gap + tSize.width + padR;

    const rect = $.NSMakeRect(x, y, chipW, chipH);
    const path = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect, chipH / 2.0, chipH / 2.0);
    rgba(255, 255, 255, 0.85).setFill;
    path.fill;
    rgba(10, 132, 255, 0.22).setStroke;
    path.setLineWidth(1.2);
    path.stroke;

    // Blue accent dot
    const dotY = y + (chipH - dotSize) / 2.0;
    rgba(10, 132, 255, 1.0).setFill;
    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(x + padL, dotY, dotSize, dotSize)).fill;

    drawText(text, x + padL + dotSize + gap, y + (chipH - tSize.height) / 2.0 + 0.5, textAttrs);
    return chipW;
}

function drawScreenLabelCard(ctx, cx, y, screenTitle, screenMeta, zoomText, isAccent) {
    const titleAttrs = makeTextAttrs(14.5, $.NSFontWeightBold, rgba(29, 29, 31, 1.0), -0.2);
    const metaAttrs = makeTextAttrs(12.0, $.NSFontWeightMedium, rgba(110, 110, 115, 1.0), 0);
    const zoomAttrs = makeTextAttrs(15.0, $.NSFontWeightBold, isAccent ? $.NSColor.whiteColor : rgba(29, 29, 31, 1.0), -0.2);

    const tSize = measureText(screenTitle, titleAttrs);
    const mSize = screenMeta ? measureText(screenMeta, metaAttrs) : { width: 0, height: 0 };
    const zSize = measureText(zoomText, zoomAttrs);

    const pillW = zSize.width + 22.0;
    const pillH = 28.0;
    const textColW = Math.max(tSize.width, mSize.width);
    const cardW = 16.0 + textColW + 14.0 + pillW + 12.0;
    const cardH = 48.0;
    const cardX = cx - cardW / 2.0;

    const cardRect = $.NSMakeRect(cardX, y, cardW, cardH);
    const cardPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(cardRect, 12.0, 12.0);

    ctx.saveGraphicsState;
    const sh = $.NSShadow.alloc.init;
    sh.setShadowOffset($.NSMakeSize(0, -4));
    sh.setShadowBlurRadius(12.0);
    sh.setShadowColor(rgba(15, 35, 70, 0.10));
    sh.set;
    $.NSColor.whiteColor.setFill;
    cardPath.fill;
    ctx.restoreGraphicsState;

    rgba(15, 23, 42, 0.08).setStroke;
    cardPath.setLineWidth(1.0);
    cardPath.stroke;

    if (screenMeta) {
        drawText(screenTitle, cardX + 16.0, y + 23.0, titleAttrs);
        drawText(screenMeta, cardX + 16.0, y + 7.5, metaAttrs);
    } else {
        drawText(screenTitle, cardX + 16.0, y + (cardH - tSize.height) / 2.0 + 0.5, titleAttrs);
    }

    const pillX = cardX + cardW - pillW - 10.0;
    const pillY = y + (cardH - pillH) / 2.0;
    const pillPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(pillX, pillY, pillW, pillH), 8.0, 8.0
    );
    (isAccent ? rgba(10, 132, 255, 1.0) : rgba(235, 238, 245, 1.0)).setFill;
    pillPath.fill;

    drawText(zoomText, pillX + (pillW - zSize.width) / 2.0, pillY + (pillH - zSize.height) / 2.0 + 0.5, zoomAttrs);
}

function makeMarquee(outputPath) {
    const w = 1400;
    const h = 560;

    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
    );
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.setCurrentContext(ctx);

    const fullRect = $.NSMakeRect(0, 0, w, h);

    // 1. Full-bleed background gradient
    const bgTop = rgba(248, 250, 254, 1.0);
    const bgBottom = rgba(230, 240, 253, 1.0);
    const bgGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(bgBottom, bgTop);
    bgGrad.drawInRectAngle(fullRect, 90.0);

    // Ambient blue glows (left brand + right monitor)
    const glowInner = rgba(10, 132, 255, 0.13);
    const glowOuter = rgba(10, 132, 255, 0.0);
    const glowGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(glowInner, glowOuter);
    const leftGlow = $.NSMakePoint(260.0, 340.0);
    glowGrad.drawFromCenterRadiusToCenterRadiusOptions(leftGlow, 0.0, leftGlow, 340.0, 0);
    const rightGlow = $.NSMakePoint(1080.0, 300.0);
    glowGrad.drawFromCenterRadiusToCenterRadiusOptions(rightGlow, 0.0, rightGlow, 380.0, 0);

    // ------------------------------------------------------------------
    // LEFT COLUMN: Brand identity + Headline + Copy + Feature Chips
    // ------------------------------------------------------------------
    const leftX = 88.0;

    // App icon + Wordmark row
    const iconSize = 86.0;
    const iconY = 382.0;
    drawAppIcon(ctx, leftX, iconY, iconSize, -8, 22.0);

    const brandAttrs = makeTextAttrs(54.0, $.NSFontWeightBold, rgba(29, 29, 31, 1.0), -1.3);
    drawText("AutoZoom", leftX + iconSize + 22.0, iconY + 13.0, brandAttrs);

    // Tagline / Headline
    const headlineAttrs = makeTextAttrs(29.0, $.NSFontWeightSemibold, rgba(10, 96, 199, 1.0), -0.5);
    drawText("Per-Monitor Automatic Zoom", leftX, 314.0, headlineAttrs);

    // Supporting benefit copy
    const bodyAttrs = makeTextAttrs(19.0, $.NSFontWeightRegular, rgba(74, 85, 104, 1.0), -0.1);
    drawText("Give every display its own default page zoom.", leftX, 262.0, bodyAttrs);
    drawText("Switches automatically as windows move between screens.", leftX, 232.0, bodyAttrs);

    // Feature chips (two rows for clean spacing)
    let cx = leftX;
    const chipY1 = 154.0;
    const w1 = drawFeatureChip(ctx, cx, chipY1, "Per-Display Defaults");
    drawFeatureChip(ctx, cx + w1 + 10.0, chipY1, "Smart Resolution Presets");

    const chipY2 = 108.0;
    const w2 = drawFeatureChip(ctx, cx, chipY2, "Relative Cmd + Site Memory");
    drawFeatureChip(ctx, cx + w2 + 10.0, chipY2, "100% Offline & Private");

    // ------------------------------------------------------------------
    // RIGHT COLUMN: Dual-Display Illustration (Laptop 100% -> Monitor 125%)
    // ------------------------------------------------------------------

    // A. External 27" Monitor (Right, larger)
    const monW = 396.0;
    const monH = 252.0;
    const monX = 918.0;
    const monY = 188.0;
    const monCx = monX + monW / 2.0;

    // Stand neck + base
    const neckW = 44.0;
    const neckH = 42.0;
    const neckRect = $.NSMakeRect(monCx - neckW / 2.0, monY - neckH + 4.0, neckW, neckH);
    const standGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(rgba(180, 190, 204, 1.0), rgba(218, 224, 233, 1.0));
    standGrad.drawInRectAngle(neckRect, 0.0);

    const baseW = 132.0;
    const baseH = 10.0;
    const basePath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(monCx - baseW / 2.0, monY - neckH - 2.0, baseW, baseH), 5.0, 5.0
    );
    rgba(164, 176, 192, 1.0).setFill;
    basePath.fill;

    // Monitor outer frame with elevation shadow
    const monPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(monX, monY, monW, monH), 16.0, 16.0
    );
    ctx.saveGraphicsState;
    const monShadow = $.NSShadow.alloc.init;
    monShadow.setShadowOffset($.NSMakeSize(0, -12));
    monShadow.setShadowBlurRadius(28.0);
    monShadow.setShadowColor(rgba(15, 35, 70, 0.22));
    monShadow.set;
    rgba(28, 32, 38, 1.0).setFill;
    monPath.fill;
    ctx.restoreGraphicsState;

    // Monitor inner display area
    const monInset = 9.0;
    const monScreenRect = $.NSMakeRect(monX + monInset, monY + monInset + 4.0, monW - monInset * 2, monH - monInset * 2 - 4.0);
    const monScreenPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(monScreenRect, 9.0, 9.0);
    const wpGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(rgba(214, 232, 255, 1.0), rgba(238, 246, 255, 1.0));
    wpGrad.drawInBezierPathAngle(monScreenPath, 90.0);

    // Browser window inside External Monitor (scaled at 1.20x to show 125% zoom!)
    drawBrowserWindow(
        ctx,
        monX + 24.0,
        monY + 24.0,
        monW - 48.0,
        monH - 46.0,
        1.20,
        "125",
        "docs.example.com",
        true
    );

    // B. MacBook Laptop (Left of monitor)
    const lapW = 248.0;
    const lapH = 160.0;
    const lapX = 632.0;
    const lapY = 166.0;
    const lapCx = lapX + lapW / 2.0;

    // Laptop lid / bezel
    const lapPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(lapX, lapY, lapW, lapH), 12.0, 12.0
    );
    ctx.saveGraphicsState;
    const lapShadow = $.NSShadow.alloc.init;
    lapShadow.setShadowOffset($.NSMakeSize(0, -10));
    lapShadow.setShadowBlurRadius(22.0);
    lapShadow.setShadowColor(rgba(15, 35, 70, 0.20));
    lapShadow.set;
    rgba(34, 39, 46, 1.0).setFill;
    lapPath.fill;
    ctx.restoreGraphicsState;

    // Laptop inner screen
    const lapInset = 7.0;
    const lapScreenRect = $.NSMakeRect(lapX + lapInset, lapY + lapInset, lapW - lapInset * 2, lapH - lapInset * 2);
    const lapScreenPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(lapScreenRect, 6.0, 6.0);
    wpGrad.drawInBezierPathAngle(lapScreenPath, 90.0);

    // Browser window inside Laptop (100% zoom)
    drawBrowserWindow(
        ctx,
        lapX + 18.0,
        lapY + 16.0,
        lapW - 36.0,
        lapH - 32.0,
        0.88,
        "100",
        "docs.example.com",
        false
    );

    // Laptop aluminum base deck
    const deckW = 284.0;
    const deckH = 12.0;
    const deckX = lapCx - deckW / 2.0;
    const deckY = lapY - deckH + 2.0;
    const deckPath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(deckX, deckY, deckW, deckH), 5.0, 5.0
    );
    const deckGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(rgba(168, 178, 192, 1.0), rgba(212, 220, 230, 1.0));
    deckGrad.drawInBezierPathAngle(deckPath, 0.0);

    // C. Curved automatic transition arc above the laptop into the external monitor
    const arcPath = $.NSBezierPath.bezierPath;
    const p0 = $.NSMakePoint(lapCx + 12.0, lapY + lapH + 14.0);
    const p1 = $.NSMakePoint(monX - 12.0, 368.0);
    const c1 = $.NSMakePoint(lapCx + 18.0, 384.0);
    const c2 = $.NSMakePoint(monX - 68.0, 368.0);
    arcPath.moveToPoint(p0);
    arcPath.curveToPointControlPoint1ControlPoint2(p1, c1, c2);
    arcPath.setLineWidth(3.0);
    arcPath.setLineCapStyle($.NSLineCapStyleRound);
    rgba(10, 132, 255, 0.78).setStroke;
    arcPath.stroke;

    // Arrowhead at p1 (horizontal tangent pointing right into monitor)
    const arrowPath = $.NSBezierPath.bezierPath;
    arrowPath.moveToPoint($.NSMakePoint(p1.x - 10.0, p1.y + 7.5));
    arrowPath.lineToPoint(p1);
    arrowPath.lineToPoint($.NSMakePoint(p1.x - 10.0, p1.y - 7.5));
    arrowPath.setLineWidth(3.0);
    arrowPath.setLineCapStyle($.NSLineCapStyleRound);
    arrowPath.setLineJoinStyle($.NSLineJoinStyleRound);
    rgba(10, 132, 255, 0.92).setStroke;
    arrowPath.stroke;

    // Origin dot at p0
    rgba(10, 132, 255, 0.85).setFill;
    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(p0.x - 4.5, p0.y - 4.5, 9.0, 9.0)).fill;

    // Floating "Auto-Switch" pill cleanly above the arc
    const autoText = "Auto 100% → 125%";
    const autoAttrs = makeTextAttrs(13.0, $.NSFontWeightBold, $.NSColor.whiteColor, -0.1);
    const autoSize = measureText(autoText, autoAttrs);
    const autoW = autoSize.width + 24.0;
    const autoH = 28.0;
    const autoX = 738.0;
    const autoY = 398.0;
    const autoRect = $.NSMakeRect(autoX, autoY, autoW, autoH);
    const autoPill = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(autoRect, autoH / 2.0, autoH / 2.0);

    ctx.saveGraphicsState;
    const autoSh = $.NSShadow.alloc.init;
    autoSh.setShadowOffset($.NSMakeSize(0, -4));
    autoSh.setShadowBlurRadius(10.0);
    autoSh.setShadowColor(rgba(10, 132, 255, 0.30));
    autoSh.set;
    rgba(10, 132, 255, 1.0).setFill;
    autoPill.fill;
    ctx.restoreGraphicsState;

    drawText(autoText, autoX + (autoW - autoSize.width) / 2.0, autoY + (autoH - autoSize.height) / 2.0 + 0.5, autoAttrs);

    // D. Screen label cards underneath each display (aligned on same baseline)
    const labelY = 76.0;
    drawScreenLabelCard(ctx, lapCx, labelY, "MacBook Screen", "1728×1117", "100%", false);
    drawScreenLabelCard(ctx, monCx, labelY, "External Display", "2560×1440", "125%", true);

    const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    pngData.writeToFileAtomically($(outputPath), true);
}

function run(argv) {
    const outDir = argv[0];
    makeSmallPromo(outDir + "/promo-small.png", "Per-Monitor Automatic Zoom");
    makeSmallPromo(outDir + "/promo-small-minimal.png", "");
    makeMarquee(outDir + "/promo-marquee.png");
    makeMarqueeMinimal(outDir + "/promo-marquee-minimal.png");
}
"""


import struct
import zlib


def rgba_png_to_rgb24_png(path):
    """Rewrite an opaque 8-bit RGBA PNG into a strict 24-bit RGB PNG (color_type=2, no alpha)."""
    with open(path, "rb") as f:
        data = f.read()
    pos = 8
    width = height = 0
    idat = bytearray()
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        tag = data[pos + 4 : pos + 8]
        chunk_data = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, _, _, _ = struct.unpack(">IIBBBBB", chunk_data)
            if color_type == 2:
                return  # already 24-bit RGB
        elif tag == b"IDAT":
            idat.extend(chunk_data)

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    prev_row = bytearray(stride)
    rgb_raw = bytearray()
    idx = 0

    for _ in range(height):
        ftype = raw[idx]
        idx += 1
        row = bytearray(raw[idx : idx + stride])
        idx += stride
        if ftype == 1:  # Sub
            for i in range(4, stride):
                row[i] = (row[i] + row[i - 4]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                row[i] = (row[i] + prev_row[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                a = row[i - 4] if i >= 4 else 0
                b = prev_row[i]
                row[i] = (row[i] + ((a + b) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = row[i - 4] if i >= 4 else 0
                b = prev_row[i]
                c = prev_row[i - 4] if i >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pr) & 0xFF
        prev_row = row

        rgb_raw.append(0)  # filter type 0 (None)
        for x in range(0, stride, 4):
            rgb_raw.extend(row[x : x + 3])

    def make_chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # color_type=2 (RGB)
    out = (
        b"\x89PNG\r\n\x1a\n"
        + make_chunk(b"IHDR", ihdr)
        + make_chunk(b"IDAT", zlib.compress(bytes(rgb_raw), 9))
        + make_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(out)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "store-assets")
    os.makedirs(out_dir, exist_ok=True)
    subprocess.run(
        ["osascript", "-l", "JavaScript", "-e", JXA_SCRIPT, out_dir],
        check=True,
    )
    outputs = [
        ("promo-small.png", "440x280"),
        ("promo-small-minimal.png", "440x280"),
        ("promo-marquee.png", "1400x560"),
        ("promo-marquee-minimal.png", "1400x560"),
    ]
    for name, dims in outputs:
        rgba_png_to_rgb24_png(os.path.join(out_dir, name))
        print(f"Created store-assets/{name} ({dims}, 24-bit RGB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

