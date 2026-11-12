import { describe, expect, it } from "vitest";
import {
  shotClip,
  type ViewMetrics,
} from "../packages/browser-control/src/route.js";

/* These pin the contract that makes a coordinate taken from a screenshot safe
 * to hand back as a click: one space (CSS pixels), independent of the device
 * pixel ratio and of how far the page is scrolled. The ratio itself never
 * reaches this function, which is the point -- the capture carries `scale: 1`
 * and the rect is named in CSS pixels, so the image cannot come back in device
 * pixels. */

const view = (over: Partial<ViewMetrics> = {}): ViewMetrics => ({
  width: 1280,
  height: 757,
  scrollX: 0,
  scrollY: 0,
  documentHeight: 757,
  ...over,
});

describe("shotClip", () => {
  it("names the viewport in css pixels at the top of the page", () => {
    expect(shotClip(view(), false)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 757,
      scale: 1,
    });
  });

  it("follows the page when it is scrolled", () => {
    const clip = shotClip(
      view({ scrollX: 0, scrollY: 1200, documentHeight: 5000 }),
      false,
    );

    expect(clip).toEqual({ x: 0, y: 1200, width: 1280, height: 757, scale: 1 });
  });

  it("keeps a full-page capture as wide as the viewport", () => {
    const clip = shotClip(view({ scrollY: 1200, documentHeight: 2039 }), true);

    // A scrollbar used to shrink this to 1265 px, which made the picture and
    // the input space disagree by 15 px.
    expect(clip).toEqual({ x: 0, y: 0, width: 1280, height: 2039, scale: 1 });
  });

  it("never asks chrome for a zero-sized rect", () => {
    const nothing: ViewMetrics = {
      width: 0,
      height: 0,
      scrollX: 0,
      scrollY: 0,
      documentHeight: 0,
    };

    expect(shotClip(nothing, false)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      scale: 1,
    });
    expect(shotClip(nothing, true)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      scale: 1,
    });
  });

  it("rounds a fractional viewport instead of sending a fractional clip", () => {
    const clip = shotClip(
      {
        width: 1279.5,
        height: 755.4,
        scrollX: 0.6,
        scrollY: 12.7,
        documentHeight: 900,
      },
      false,
    );

    expect(clip).toEqual({ x: 1, y: 13, width: 1280, height: 755, scale: 1 });
  });
});
