const std = @import("std");
const Io = std.Io;
const posix = std.posix;
const system = posix.system;

fn usage(argv0: []const u8) noreturn {
    std.debug.print("usage: {s} <target> <old-text-file> <new-text-file>\n", .{argv0});
    std.process.exit(1);
}

fn fatal(comptime message: []const u8, err: anyerror) noreturn {
    std.debug.print(message ++ ": {s}\n", .{@errorName(err)});
    std.process.exit(1);
}

fn fatalMessage(comptime message: []const u8) noreturn {
    std.debug.print(message ++ "\n", .{});
    std.process.exit(1);
}

fn fatalErrno(comptime message: []const u8, err: std.posix.E) noreturn {
    std.debug.print(message ++ ": {s}\n", .{@tagName(err)});
    std.process.exit(1);
}

fn writeAllFd(fd: i32, content: []const u8) void {
    var written: usize = 0;
    while (written < content.len) {
        const rc = system.write(fd, content[written..].ptr, content.len - written);
        switch (posix.errno(rc)) {
            .SUCCESS => {
                const n: usize = @intCast(rc);
                if (n == 0) fatalErrno("write output", .IO);
                written += n;
            },
            .INTR => {},
            else => |err| fatalErrno("write output", err),
        }
    }
}

fn toPosixPath(path: []const u8) [std.posix.PATH_MAX - 1:0]u8 {
    return posix.toPosixPath(path) catch fatal("path", error.NameTooLong);
}

fn unlinkPath(path: []const u8) void {
    const path_z = toPosixPath(path);
    _ = system.unlink(&path_z);
}

fn renamePath(old_path: []const u8, new_path: []const u8) void {
    const old_z = toPosixPath(old_path);
    const new_z = toPosixPath(new_path);
    const rc = system.renameat(posix.AT.FDCWD, &old_z, posix.AT.FDCWD, &new_z);
    switch (posix.errno(rc)) {
        .SUCCESS => {},
        else => |err| {
            unlinkPath(old_path);
            fatalErrno("rename output", err);
        },
    }
}

fn writeJson(bytes: usize) void {
    var buf: [96]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "{{\"ok\":true,\"bytes\":{}}}\n", .{bytes}) catch unreachable;
    writeAllFd(1, text);
}

fn writeOutput(target_path: []const u8, tmp_path: []const u8, target: []const u8, new_text: []const u8, prefix_size: usize, suffix_offset: usize) void {
    const fd = posix.openat(posix.AT.FDCWD, tmp_path, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .CLOEXEC = true }, 0o644) catch |err| fatal("open tmp output", err);
    writeAllFd(fd, target[0..prefix_size]);
    writeAllFd(fd, new_text);
    writeAllFd(fd, target[suffix_offset..]);

    var rc = system.fsync(fd);
    switch (posix.errno(rc)) {
        .SUCCESS => {},
        else => |err| fatalErrno("fsync output", err),
    }
    rc = system.close(fd);
    switch (posix.errno(rc)) {
        .SUCCESS => {},
        else => |err| fatalErrno("close output", err),
    }

    renamePath(tmp_path, target_path);
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 4) usage(args[0]);

    const target_path = args[1];
    const old_text_path = args[2];
    const new_text_path = args[3];

    const target = Io.Dir.cwd().readFileAlloc(io, target_path, arena, .limited(std.math.maxInt(usize))) catch |err| fatal("open input", err);
    const old_text = Io.Dir.cwd().readFileAlloc(io, old_text_path, arena, .limited(std.math.maxInt(usize))) catch |err| fatal("open input", err);
    const new_text = Io.Dir.cwd().readFileAlloc(io, new_text_path, arena, .limited(std.math.maxInt(usize))) catch |err| fatal("open input", err);

    if (old_text.len == 0) fatalMessage("oldText must not be empty");

    const first_index = std.mem.indexOf(u8, target, old_text) orelse fatalMessage("oldText not found");
    const second_start = first_index + old_text.len;
    if (std.mem.indexOf(u8, target[second_start..], old_text) != null) fatalMessage("oldText not unique");

    const suffix_offset = first_index + old_text.len;
    const output_size = first_index + new_text.len + (target.len - suffix_offset);
    const tmp_path = std.fmt.allocPrint(arena, "{s}.tmp.{}", .{ target_path, system.getpid() }) catch |err| fatal("malloc", err);
    if (tmp_path.len > 4095) fatalMessage("temporary path too long");

    writeOutput(target_path, tmp_path, target, new_text, first_index, suffix_offset);
    writeJson(output_size);
}
