const std = @import("std");
const scoring = @import("scoring.zig");
const Io = std.Io;
const Doc = scoring.Doc;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len == 4 and std.mem.eql(u8, args[1], "--fixture")) {
        return writeFixture(io, try std.fmt.parseInt(usize, args[2], 10), args[3]);
    }
    if (args.len < 5) return usage();

    const url_mode = std.mem.eql(u8, args[1], "--urls");
    if (url_mode) {
        if (args.len != 7 and args.len != 8) return usage();
    } else if (args.len != 5 and args.len != 6) return usage();
    const base: usize = if (url_mode) 2 else 1;
    const query = args[base];
    const max_results = try std.fmt.parseInt(usize, args[base + 1], 10);
    const content_chars = try std.fmt.parseInt(usize, args[base + 2], 10);
    const input = try Io.Dir.cwd().readFileAlloc(io, args[base + 3], arena, .limited(64 * 1024 * 1024));
    const delay_ms = if (url_mode and args.len > base + 4) try std.fmt.parseInt(i64, args[base + 4], 10) else 0;
    const output_arg_index: usize = if (url_mode) base + 5 else base + 4;
    const output_content = args.len <= output_arg_index or !std.mem.eql(u8, args[output_arg_index], "0");
    const terms = try splitTerms(arena, query);
    const docs = if (url_mode)
        try fetchUrls(arena, io, input, content_chars, terms, delay_ms)
    else
        try parseCorpus(arena, input, content_chars, terms);

    std.mem.sort(Doc, docs, {}, scoring.moreRelevant);

    var stdout_buffer: [8192]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const out = &stdout_writer.interface;
    const shown = @min(max_results, docs.len);
    try out.print("Native Zig search found {} result(s) for `{s}`.\n\n", .{ shown, query });
    var i: usize = 0;
    while (i < shown) : (i += 1) {
        const doc = docs[i];
        try out.print("## {}. {s}\n\n{s}\n\nScore: {}; kind={s}; contentType={s}\nScoreBreakdown: bm25={}; title={}; url={}; phrase={}; source={}\n\n", .{
            i + 1,
            if (doc.title.len > 0) doc.title else doc.url,
            doc.url,
            doc.score,
            doc.kind,
            doc.content_type,
            doc.score_breakdown.bm25,
            doc.score_breakdown.title,
            doc.score_breakdown.url,
            doc.score_breakdown.phrase,
            doc.score_breakdown.source,
        });
        try writeSnippet(out, doc.content, terms);
        if (output_content) {
            try out.writeAll("\n\n");
            try out.writeAll(doc.content);
        }
        try out.writeAll("\n\n");
    }
    try out.flush();
}

fn usage() void {
    std.debug.print("usage: native-search-zig [--urls] <query> <max_results> <content_chars> <raw-corpus.tsv|urls.txt> [delay_ms] [output_content:0|1]\n       native-search-zig --fixture <repeat> <raw-corpus.tsv>\n", .{});
}

fn writeFixture(io: Io, repeat: usize, path: []const u8) !void {
    const rows = [_][]const u8{
        "aHR0cHM6Ly9hbHBoYS5leGFtcGxlL2RvY3MvbmF0aXZlLXNlYXJjaC5tZA==\tdGV4dC9tYXJrZG93bg==\tIyBOYXRpdmUgU2VhcmNoIEd1aWRlCgpOYXRpdmUgc2VhcmNoIHByZWZlcnMgbGxtcy50eHQsIHNpdGVtYXBzLCBtYXJrZG93biwgYW5kIHJhdyBjb250ZW50LiBJdCB1c2VzIGJvdW5kZWQgZGlzY292ZXJ5IGFuZCBleGFjdCBVUkwgbW9kZS4=\n",
        "aHR0cHM6Ly9icmF2by5leGFtcGxlL2FydGljbGVzL2V4dHJhY3QuaHRtbA==\tdGV4dC9odG1s\tPCFkb2N0eXBlIGh0bWw+PGh0bWw+PGhlYWQ+PHRpdGxlPlJlbGlhYmxlIEV4dHJhY3Rpb248L3RpdGxlPjwvaGVhZD48Ym9keT48YXJ0aWNsZT48aDE+UmVsaWFibGUgRXh0cmFjdGlvbjwvaDE+PHA+RXh0cmFjdGlvbiByZW1vdmVzIHNjcmlwdCBhbmQgbmF2aWdhdGlvbiBub2lzZSwgcHJlc2VydmVzIHNuaXBwZXRzLCBhbmQgZW1pdHMgbWFya2Rvd24tbGlrZSB0ZXh0LjwvcD48cHJlPmNvbnN0IG9rID0gdHJ1ZTs8L3ByZT48L2FydGljbGU+PC9ib2R5PjwvaHRtbD4=\n",
        "aHR0cHM6Ly9jaGFybGllLmV4YW1wbGUvcmVmZXJlbmNlL3JhdGUtbGltaXRz\tdGV4dC9odG1s\tPG1haW4+PGgxPlJlc3BvbnNpYmxlIEJlbmNobWFya3M8L2gxPjxwPkJlbmNobWFya3MgbXVzdCBiZSBsb2NhbCBvciBjYWNoZWQsIGF2b2lkIG1hbnkgcmVxdWVzdHMsIHVzZSBtdWx0aXBsZSBvcmlnaW5zLCBhbmQgbmV2ZXIgdHJ5IHRvIGV2YWRlIGJhbnMuPC9wPjwvbWFpbj4=\n",
        "aHR0cHM6Ly9kZWx0YS5leGFtcGxlL2xsbXMudHh0\tdGV4dC9wbGFpbg==\tIyBEZWx0YSBEb2NzCgotIFtNYXJrZG93biBBUEldKGh0dHBzOi8vZGVsdGEuZXhhbXBsZS9hcGkubWQpCi0gW1NlYXJjaCBEZXNpZ25dKGh0dHBzOi8vZGVsdGEuZXhhbXBsZS9zZWFyY2gtZGVzaWduLm1kKQoKVXNlIG1hcmtkb3duIGZpcnN0IGJlY2F1c2UgbWFueSBkb2N1bWVudGF0aW9uIHdlYnNpdGVzIGV4cG9zZSBpdCBkaXJlY3RseS4=\n",
    };
    var file = try Io.Dir.cwd().createFile(io, path, .{ .truncate = true });
    defer file.close(io);
    var i: usize = 0;
    while (i < repeat) : (i += 1) for (rows) |row| try file.writeStreamingAll(io, row);
}

fn fetchUrls(arena: std.mem.Allocator, io: Io, urls_text: []const u8, max_chars: usize, terms: []const []const u8, delay_ms: i64) ![]Doc {
    var line_count: usize = 0;
    var count_it = std.mem.splitScalar(u8, urls_text, '\n');
    while (count_it.next()) |line| {
        if (std.mem.trim(u8, line, "\r\t ").len > 0) line_count += 1;
    }
    var docs = try arena.alloc(Doc, line_count);
    var client: std.http.Client = .{ .allocator = arena, .io = io };
    defer client.deinit();

    var used: usize = 0;
    var lines = std.mem.splitScalar(u8, urls_text, '\n');
    while (lines.next()) |line_raw| {
        const url = std.mem.trim(u8, line_raw, "\r\t ");
        if (url.len == 0) continue;
        if (used > 0 and delay_ms > 0) try Io.sleep(io, Io.Duration.fromMilliseconds(delay_ms), .awake);
        const fetched = fetchOne(arena, &client, url) catch continue;
        const extracted = try extract(arena, fetched.url, "", fetched.body, max_chars);
        docs[used] = extracted;
        docs[used].score_breakdown = scoring.scoreDocDetailed(extracted, terms);
        docs[used].score = docs[used].score_breakdown.total();
        used += 1;
    }
    return docs[0..used];
}

const Fetched = struct { url: []const u8, body: []const u8 };

fn fetchOne(arena: std.mem.Allocator, client: *std.http.Client, url: []const u8) !Fetched {
    var aw: Io.Writer.Allocating = .init(arena);
    const headers = [_]std.http.Header{
        .{ .name = "user-agent", .value = "tia-runtime-native-search-zig/0.1" },
        .{ .name = "accept", .value = "text/markdown,text/plain;q=0.95,text/html;q=0.9,*/*;q=0.2" },
    };
    const result = try client.fetch(.{
        .location = .{ .url = url },
        .response_writer = &aw.writer,
        .extra_headers = &headers,
    });
    if (@intFromEnum(result.status) >= 400) return error.HttpStatus;
    return .{ .url = url, .body = aw.written() };
}

fn parseCorpus(arena: std.mem.Allocator, corpus: []const u8, max_chars: usize, terms: []const []const u8) ![]Doc {
    var line_count: usize = 0;
    var count_it = std.mem.splitScalar(u8, corpus, '\n');
    while (count_it.next()) |line| {
        if (std.mem.trim(u8, line, "\r\t ").len > 0) line_count += 1;
    }
    var docs = try arena.alloc(Doc, line_count);
    var used: usize = 0;
    var lines = std.mem.splitScalar(u8, corpus, '\n');
    while (lines.next()) |line_raw| {
        const line = std.mem.trim(u8, line_raw, "\r\n");
        if (line.len == 0) continue;
        var fields = std.mem.splitScalar(u8, line, '\t');
        const url = try decodeB64(arena, fields.next() orelse "");
        const content_type = try decodeB64(arena, fields.next() orelse "");
        const raw = try decodeB64(arena, fields.next() orelse "");
        const extracted = try extract(arena, url, content_type, raw, max_chars);
        docs[used] = extracted;
        docs[used].score_breakdown = scoring.scoreDocDetailed(extracted, terms);
        docs[used].score = docs[used].score_breakdown.total();
        used += 1;
    }
    return docs[0..used];
}

fn decodeB64(arena: std.mem.Allocator, encoded: []const u8) ![]u8 {
    const size = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const out = try arena.alloc(u8, size);
    try std.base64.standard.Decoder.decode(out, encoded);
    return out;
}

fn extract(arena: std.mem.Allocator, url: []const u8, content_type: []const u8, raw: []const u8, max_chars: usize) !Doc {
    const html = containsFold(content_type, "html") or containsFold(raw[0..@min(raw.len, 4096)], "<html") or containsFold(raw[0..@min(raw.len, 4096)], "<body");
    if (html) {
        const title = try htmlTitle(arena, raw);
        const body = htmlMain(raw);
        const content = try htmlToText(arena, body, max_chars);
        return .{ .url = url, .content_type = content_type, .title = title, .content = content, .kind = "html", .score = 0 };
    }
    const content = try plainClean(arena, raw, max_chars);
    return .{ .url = url, .content_type = content_type, .title = "", .content = content, .kind = "markdown", .score = 0 };
}

fn htmlTitle(arena: std.mem.Allocator, html: []const u8) ![]const u8 {
    const start_tag = indexOfFold(html, "<title") orelse return "";
    const after_gt_rel = std.mem.indexOfScalar(u8, html[start_tag..], '>') orelse return "";
    const body_start = start_tag + after_gt_rel + 1;
    const end_rel = indexOfFold(html[body_start..], "</title>") orelse return "";
    return htmlToText(arena, html[body_start .. body_start + end_rel], 240);
}

fn htmlMain(html: []const u8) []const u8 {
    if (tagBody(html, "article")) |body| return body;
    if (tagBody(html, "main")) |body| return body;
    if (tagBody(html, "body")) |body| return body;
    return html;
}

fn tagBody(html: []const u8, tag: []const u8) ?[]const u8 {
    var open_buf: [32]u8 = undefined;
    var close_buf: [32]u8 = undefined;
    const open = std.fmt.bufPrint(&open_buf, "<{s}", .{tag}) catch return null;
    const close = std.fmt.bufPrint(&close_buf, "</{s}>", .{tag}) catch return null;
    const open_at = indexOfFold(html, open) orelse return null;
    const gt_rel = std.mem.indexOfScalar(u8, html[open_at..], '>') orelse return null;
    const body_start = open_at + gt_rel + 1;
    const close_rel = indexOfFold(html[body_start..], close) orelse return html[body_start..];
    return html[body_start .. body_start + close_rel];
}

fn htmlToText(arena: std.mem.Allocator, html: []const u8, max_chars: usize) ![]const u8 {
    const out = try arena.alloc(u8, @min(html.len + 16, max_chars + 1024));
    var n: usize = 0;
    var i: usize = 0;
    var in_tag = false;
    while (i < html.len and n + 4 < out.len and n < max_chars) : (i += 1) {
        const c = html[i];
        if (c == '<') {
            in_tag = true;
            if (startsTag(html[i..], "br") or startsTag(html[i..], "p") or startsTag(html[i..], "li") or startsTag(html[i..], "h")) n = appendSpace(out, n, '\n');
            continue;
        }
        if (in_tag) {
            if (c == '>') in_tag = false;
            continue;
        }
        if (c == '&') {
            const decoded = entity(html[i..]);
            if (decoded.char != 0) {
                n = appendSpace(out, n, decoded.char);
                i += decoded.skip - 1;
                continue;
            }
        }
        n = appendSpace(out, n, c);
    }
    return std.mem.trim(u8, out[0..n], " \t\r\n");
}

fn startsTag(s: []const u8, tag: []const u8) bool {
    return s.len > tag.len + 1 and s[0] == '<' and eqlFold(s[1 .. 1 + tag.len], tag);
}

fn entity(s: []const u8) struct { char: u8, skip: usize } {
    const entities = [_]struct { text: []const u8, char: u8 }{
        .{ .text = "&amp;", .char = '&' },  .{ .text = "&lt;", .char = '<' },
        .{ .text = "&gt;", .char = '>' },   .{ .text = "&quot;", .char = '"' },
        .{ .text = "&#39;", .char = '\'' }, .{ .text = "&nbsp;", .char = ' ' },
    };
    for (entities) |e| if (std.mem.startsWith(u8, s, e.text)) return .{ .char = e.char, .skip = e.text.len };
    return .{ .char = 0, .skip = 0 };
}

fn plainClean(arena: std.mem.Allocator, text: []const u8, max_chars: usize) ![]const u8 {
    const out = try arena.alloc(u8, @min(text.len, max_chars));
    var n: usize = 0;
    for (text) |c| {
        if (n >= out.len) break;
        n = appendSpace(out, n, c);
    }
    return std.mem.trim(u8, out[0..n], " \t\r\n");
}

fn appendSpace(out: []u8, n: usize, c: u8) usize {
    const normalized: u8 = if (c == '\r' or c == '\t') ' ' else c;
    if (normalized == ' ' and (n == 0 or out[n - 1] == ' ')) return n;
    if (normalized == '\n' and n > 0 and out[n - 1] == '\n') return n;
    out[n] = normalized;
    return n + 1;
}

fn splitTerms(arena: std.mem.Allocator, query: []const u8) ![]const []const u8 {
    var temp = try arena.alloc([]const u8, 32);
    var used: usize = 0;
    var it = std.mem.tokenizeAny(u8, query, " \t\r\n,.;:!?()[]{}\"'");
    while (it.next()) |term| {
        if (term.len < 2 or used >= temp.len) continue;
        temp[used] = term;
        used += 1;
    }
    return temp[0..used];
}

fn writeSnippet(out: *Io.Writer, content: []const u8, terms: []const []const u8) !void {
    var at: usize = 0;
    for (terms) |term| if (indexOfFold(content, term)) |idx| {
        at = idx;
        break;
    };
    const start = if (at > 120) at - 120 else 0;
    const end = @min(content.len, at + 300);
    try out.writeAll("Snippet: ");
    if (start > 0) try out.writeAll("…");
    try out.writeAll(content[start..end]);
    if (end < content.len) try out.writeAll("…");
    try out.writeAll("\n");
}

fn containsFold(haystack: []const u8, needle: []const u8) bool {
    return indexOfFold(haystack, needle) != null;
}

fn indexOfFold(haystack: []const u8, needle: []const u8) ?usize {
    if (needle.len == 0 or haystack.len < needle.len) return null;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) if (eqlFold(haystack[i .. i + needle.len], needle)) return i;
    return null;
}

fn eqlFold(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, 0..) |c, i| if (lower(c) != lower(b[i])) return false;
    return true;
}

fn lower(c: u8) u8 {
    return if (c >= 'A' and c <= 'Z') c + 32 else c;
}
