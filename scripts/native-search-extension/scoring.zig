const std = @import("std");

pub const ScoreBreakdown = struct {
    bm25: u64 = 0,
    title: u64 = 0,
    url: u64 = 0,
    phrase: u64 = 0,
    source: u64 = 0,

    pub fn total(self: ScoreBreakdown) u64 {
        return self.bm25 + self.title + self.url + self.phrase + self.source;
    }
};

pub const Doc = struct {
    url: []const u8,
    content_type: []const u8,
    title: []const u8,
    content: []const u8,
    kind: []const u8,
    score: u64,
    score_breakdown: ScoreBreakdown = .{},
};

pub fn scoreDoc(doc: Doc, terms: []const []const u8) u64 {
    return scoreDocDetailed(doc, terms).total();
}

pub fn scoreDocDetailed(doc: Doc, terms: []const []const u8) ScoreBreakdown {
    var breakdown = ScoreBreakdown{ .source = if (std.mem.eql(u8, doc.kind, "markdown")) 4 else 0 };
    var matched: usize = 0;
    for (terms) |term| {
        const title_count = countFold(doc.title, term);
        const url_count = countFold(doc.url, term);
        const body_count = countFold(doc.content, term);
        if (title_count + url_count + body_count > 0) matched += 1;
        const title_hits: u64 = @min(title_count, @as(u64, 2));
        const url_hits: u64 = @min(url_count, @as(u64, 2));
        const body_hits: u64 = @min(body_count, @as(u64, 3));
        breakdown.title += title_hits * 18;
        breakdown.url += url_hits * 8;
        if (body_count > 0) breakdown.bm25 += 3 + body_hits;
    }
    if (terms.len > 0) {
        breakdown.bm25 += @as(u64, @intCast(matched)) * 12;
        if (matched == terms.len) breakdown.bm25 += 30;
        if (hasOrderedTerms(doc.title, terms) or hasOrderedTerms(doc.url, terms) or hasOrderedTerms(doc.content, terms)) breakdown.phrase += 10;
    }
    return breakdown;
}

pub fn moreRelevant(_: void, a: Doc, b: Doc) bool {
    return a.score > b.score;
}

fn hasOrderedTerms(haystack: []const u8, terms: []const []const u8) bool {
    if (terms.len < 2) return false;
    var from: usize = 0;
    for (terms) |term| {
        const found = indexOfFold(haystack[from..], term) orelse return false;
        from += found + term.len;
    }
    return true;
}

fn indexOfFold(haystack: []const u8, needle: []const u8) ?usize {
    if (needle.len == 0 or haystack.len < needle.len) return null;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (eqlFold(haystack[i .. i + needle.len], needle)) return i;
    }
    return null;
}

fn countFold(haystack: []const u8, needle: []const u8) u64 {
    if (needle.len == 0 or haystack.len < needle.len) return 0;
    var count: u64 = 0;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (eqlFold(haystack[i .. i + needle.len], needle)) count += 1;
    }
    return count;
}

fn eqlFold(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, 0..) |c, i| if (lower(c) != lower(b[i])) return false;
    return true;
}

fn lower(c: u8) u8 {
    return if (c >= 'A' and c <= 'Z') c + 32 else c;
}

test "title and all-term matches outrank repeated body-only matches" {
    const terms = [_][]const u8{ "native", "search" };
    const title_doc = Doc{ .url = "https://example.com/docs/native-search", .content_type = "text/markdown", .title = "Native Search Guide", .content = "short guide", .kind = "markdown", .score = 0 };
    const body_doc = Doc{ .url = "https://example.com/blog", .content_type = "text/html", .title = "Blog", .content = "native native native native native search", .kind = "html", .score = 0 };

    try std.testing.expect(scoreDoc(title_doc, &terms) > scoreDoc(body_doc, &terms));
}

test "broad all-term coverage outranks single-term body spam" {
    const terms = [_][]const u8{ "cloudflare", "workers", "nodejs", "compatibility" };
    const coverage_doc = Doc{ .url = "https://developers.cloudflare.com/workers/runtime-apis/nodejs/", .content_type = "text/markdown", .title = "Node.js compatibility in Workers", .content = "Enable nodejs_compat for module compatibility in Cloudflare Workers.", .kind = "markdown", .score = 0 };
    const spam_doc = Doc{ .url = "https://developers.cloudflare.com/blog", .content_type = "text/html", .title = "Blog", .content = "cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare cloudflare", .kind = "html", .score = 0 };

    try std.testing.expect(scoreDoc(coverage_doc, &terms) > scoreDoc(spam_doc, &terms));
}
