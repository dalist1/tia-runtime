const std = @import("std");
const Io = std.Io;
const posix = std.posix;
const system = posix.system;

const max_bytes = 256_000;

fn usage(argv0: []const u8) noreturn {
    std.debug.print("usage: {s} <file> <offset> <limit>\n", .{argv0});
    std.process.exit(1);
}

fn fatal(comptime message: []const u8, err: anyerror) noreturn {
    std.debug.print(message ++ ": {s}\n", .{@errorName(err)});
    std.process.exit(1);
}

fn fatalErrno(comptime message: []const u8, err: std.posix.E) noreturn {
    std.debug.print(message ++ ": {s}\n", .{@tagName(err)});
    std.process.exit(1);
}

fn writeAll(bytes: []const u8) void {
    var written: usize = 0;
    while (written < bytes.len) {
        const rc = system.write(1, bytes[written..].ptr, bytes.len - written);
        switch (posix.errno(rc)) {
            .SUCCESS => {
                const n: usize = @intCast(rc);
                if (n == 0) fatalErrno("write", .IO);
                written += n;
            },
            .INTR => {},
            else => |err| fatalErrno("write", err),
        }
    }
}

fn formatSize(out: []u8, bytes: usize) []const u8 {
    const units = [_][]const u8{ "B", "KB", "MB", "GB" };
    var value: f64 = @floatFromInt(bytes);
    var unit: usize = 0;
    while (value >= 1024.0 and unit < units.len - 1) : (unit += 1) {
        value /= 1024.0;
    }
    if (unit == 0) {
        return std.fmt.bufPrint(out, "{} {s}", .{ bytes, units[unit] }) catch unreachable;
    }
    return std.fmt.bufPrint(out, "{d:.1} {s}", .{ value, units[unit] }) catch unreachable;
}

fn parsePositive(value: []const u8) ?usize {
    const parsed = std.fmt.parseInt(i64, value, 10) catch return null;
    if (parsed < 1) return null;
    return @intCast(parsed);
}

fn emitLineLimit(start_line: usize, output_lines: usize) void {
    var buf: [256]u8 = undefined;
    const end_line = start_line + output_lines - 1;
    const next_offset = end_line + 1;
    const text = std.fmt.bufPrint(&buf, "\n\n[Showing lines {}-{}. Use offset={} to continue.]", .{ start_line, end_line, next_offset }) catch unreachable;
    writeAll(text);
}

fn emitByteLimit(start_line: usize, output_lines: usize, output_bytes: usize, first_line_excess: usize) void {
    var buf: [256]u8 = undefined;
    if (output_lines == 0) {
        var size_buf: [64]u8 = undefined;
        var limit_buf: [64]u8 = undefined;
        const text = std.fmt.bufPrint(&buf, "[Line {} is {s}, exceeds {s} limit.]", .{
            start_line,
            formatSize(&size_buf, first_line_excess),
            formatSize(&limit_buf, max_bytes),
        }) catch unreachable;
        writeAll(text);
    } else {
        var limit_buf: [64]u8 = undefined;
        const end_line = start_line + output_lines - 1;
        const next_offset = end_line + 1;
        const text = std.fmt.bufPrint(&buf, "\n\n[Showing lines {}-{} ({s} limit). Use offset={} to continue.]", .{
            start_line,
            end_line,
            formatSize(&limit_buf, output_bytes),
            next_offset,
        }) catch unreachable;
        writeAll(text);
    }
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 4) usage(args[0]);

    const path = args[1];
    const start_line = parsePositive(args[2]) orelse {
        std.debug.print("offset and limit must be >= 1\n", .{});
        std.process.exit(1);
    };
    const max_lines = parsePositive(args[3]) orelse {
        std.debug.print("offset and limit must be >= 1\n", .{});
        std.process.exit(1);
    };

    const stat = Io.Dir.cwd().statFile(io, path, .{}) catch |err| fatal("stat", err);
    if (stat.size == 0) return;
    if (stat.size > std.math.maxInt(usize)) fatal("stat", error.FileTooBig);
    const file_size: usize = @intCast(stat.size);

    const fd = posix.openat(posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0) catch |err| fatal("open", err);
    defer _ = system.close(fd);

    const mapped = posix.mmap(null, file_size, .{ .READ = true }, .{ .TYPE = .PRIVATE }, fd, 0) catch |err| fatal("mmap", err);
    defer posix.munmap(mapped);
    const data: []const u8 = mapped;

    var current_line: usize = 1;
    var line_start: usize = 0;
    var output_lines: usize = 0;
    var output_bytes: usize = 0;
    var hit_line_limit = false;
    var hit_byte_limit = false;
    var first_line_excess: usize = 0;

    var i: usize = 0;
    while (i < data.len) : (i += 1) {
        if (data[i] != '\n') continue;
        const line_len = i - line_start + 1;
        if (current_line >= start_line) {
            if (output_lines >= max_lines) {
                hit_line_limit = true;
                break;
            }
            if (output_bytes + line_len > max_bytes) {
                hit_byte_limit = true;
                if (output_lines == 0) first_line_excess = line_len;
                break;
            }
            writeAll(data[line_start .. i + 1]);
            output_lines += 1;
            output_bytes += line_len;
        }
        current_line += 1;
        line_start = i + 1;
    }

    if (!hit_line_limit and !hit_byte_limit and line_start < data.len and current_line >= start_line) {
        const line_len = data.len - line_start;
        if (output_lines >= max_lines) {
            hit_line_limit = true;
        } else if (output_bytes + line_len > max_bytes) {
            hit_byte_limit = true;
            if (output_lines == 0) first_line_excess = line_len;
        } else {
            writeAll(data[line_start..]);
            output_lines += 1;
            output_bytes += line_len;
        }
    }

    if (hit_line_limit) {
        emitLineLimit(start_line, output_lines);
    } else if (hit_byte_limit) {
        emitByteLimit(start_line, output_lines, output_bytes, first_line_excess);
    }
}
