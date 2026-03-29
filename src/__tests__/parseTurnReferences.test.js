import { describe, it, expect } from "vitest";
import { parseTurnReferences } from "../components/QAView.jsx";

describe("parseTurnReferences", function () {
  it("parses single bracketed turn reference", function () {
    var parts = parseTurnReferences("See [Turn 5] for details.");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ type: "ref", turnIndex: 5, value: "[Turn 5]" });
  });

  it("parses comma-separated turn references in one bracket group", function () {
    var parts = parseTurnReferences("Goals discussed [Turn 0, Turn 5].");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(2);
    expect(refs[0].turnIndex).toBe(0);
    expect(refs[1].turnIndex).toBe(5);
  });

  it("parses multiple comma-separated turns", function () {
    var parts = parseTurnReferences("[Turn 0, Turn 5, Turn 115, Turn 116]");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(4);
    expect(refs.map(function (r) { return r.turnIndex; })).toEqual([0, 5, 115, 116]);
  });

  it("parses dash-separated range like [Turn 10 - Turn 20]", function () {
    var parts = parseTurnReferences("Spans [Turn 10 - Turn 20].");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(11);
    expect(refs[0].turnIndex).toBe(10);
    expect(refs[10].turnIndex).toBe(20);
  });

  it("parses unbracketed turn references", function () {
    var parts = parseTurnReferences("This happened in Turn 3 and continued in Turn 7.");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(2);
    expect(refs.map(function (r) { return r.turnIndex; })).toEqual([3, 7]);
  });

  it("is case insensitive (turn, TURN, Turn)", function () {
    var parts = parseTurnReferences("See turn 1 then TURN 2 then Turn 3.");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(3);
    expect(refs.map(function (r) { return r.turnIndex; })).toEqual([1, 2, 3]);
  });

  it("parses bare numbers in bracket group like [Turn 1, 3, 5]", function () {
    var parts = parseTurnReferences("See [Turn 1, 3, 5].");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(3);
    expect(refs.map(function (r) { return r.turnIndex; })).toEqual([1, 3, 5]);
  });

  it("parses Turns plural with range: [Turns 0-5]", function () {
    var parts = parseTurnReferences("Review [Turns 0-5] carefully.");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(6);
    expect(refs[0].turnIndex).toBe(0);
    expect(refs[5].turnIndex).toBe(5);
  });

  it("parses mixed bracketed and unbracketed references", function () {
    var parts = parseTurnReferences("See [Turn 0, Turn 5] and also Turn 171.");
    var refs = parts.filter(function (p) { return p.type === "ref"; });
    expect(refs).toHaveLength(3);
    expect(refs.map(function (r) { return r.turnIndex; })).toEqual([0, 5, 171]);
  });

  it("preserves surrounding text as text parts", function () {
    var parts = parseTurnReferences("Before [Turn 5] after.");
    var texts = parts.filter(function (p) { return p.type === "text"; });
    expect(texts[0].value).toBe("Before ");
    expect(texts[1].value).toBe(" after.");
  });

  it("returns plain text when no references present", function () {
    var parts = parseTurnReferences("No turns here.");
    expect(parts).toEqual([{ type: "text", value: "No turns here." }]);
  });

  it("handles empty string", function () {
    var parts = parseTurnReferences("");
    expect(parts).toEqual([]);
  });
});
