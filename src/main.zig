const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const App = struct {
    io: std.Io,
    env_map: *std.process.Environ.Map,
    backend_child: ?std.process.Child = null,
    bridge_token: [64]u8 = undefined,
    bridge_token_ready: bool = false,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "co-translator",
            .source = zero_native.frontend.productionSource(.{ .dist = "dist/renderer" }),
            .source_fn = source,
            .start_fn = start,
            .stop_fn = stop,
        };
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        if (self.env_map.get("ZERO_NATIVE_FRONTEND_URL")) |url| {
            if (url.len > 0) return zero_native.WebViewSource.url(url);
        }
        const renderer_entry_url = try rendererEntryUrl(self.io, std.heap.page_allocator);
        return zero_native.WebViewSource.url(renderer_entry_url);
    }

    fn start(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        _ = context;
    }

    fn stop(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        self.stopBackend();
    }

    fn startBackend(self: *@This()) !void {
        const allocator = std.heap.page_allocator;
        _ = try self.ensureBridgeToken();
        const go_backend_path = try backendExecutablePath(self.io, allocator, "co-translator-backend");
        defer allocator.free(go_backend_path);
        const bun_script_path = try backendScriptPath(self.io, allocator, "server.bundle.js");
        defer allocator.free(bun_script_path);
        const node_script_path = try backendScriptPath(self.io, allocator, "server.js");
        defer allocator.free(node_script_path);

        const runtime = self.env_map.get("CO_TRANSLATOR_BACKEND_RUNTIME") orelse "auto";
        if (std.mem.eql(u8, runtime, "go")) {
            self.backend_child = try self.spawnGoBackend(go_backend_path);
            return;
        }
        if (std.mem.eql(u8, runtime, "bun")) {
            self.backend_child = try self.spawnBunBackend(bun_script_path);
            return;
        }
        if (std.mem.eql(u8, runtime, "node")) {
            self.backend_child = try self.spawnNodeBackend(node_script_path);
            return;
        }
        if (!std.mem.eql(u8, runtime, "auto")) return error.InvalidBackendRuntime;

        self.backend_child = self.spawnGoBackend(go_backend_path) catch |go_err| switch (go_err) {
            error.FileNotFound => self.spawnBunBackend(bun_script_path) catch |bun_err| switch (bun_err) {
                error.FileNotFound => try self.spawnNodeBackend(node_script_path),
                else => return bun_err,
            },
            else => return go_err,
        };
    }

    fn ensureBackend(self: *@This()) !void {
        if (self.env_map.get("CO_TRANSLATOR_EXTERNAL_BACKEND") != null) return;
        if (self.backend_child != null) return;
        try self.startBackend();
    }

    fn shouldEagerBackend(self: *@This()) bool {
        if (self.env_map.get("CO_TRANSLATOR_EXTERNAL_BACKEND") != null) return false;
        const value = self.env_map.get("CO_TRANSLATOR_EAGER_BACKEND") orelse return false;
        return !std.mem.eql(u8, value, "0") and !std.mem.eql(u8, value, "false");
    }

    fn shouldPrewarmBackend(self: *@This()) bool {
        if (self.env_map.get("CO_TRANSLATOR_EXTERNAL_BACKEND") != null) return false;
        if (self.shouldEagerBackend()) return false;
        const runtime = self.env_map.get("CO_TRANSLATOR_BACKEND_RUNTIME") orelse "auto";
        if (!std.mem.eql(u8, runtime, "auto") and !std.mem.eql(u8, runtime, "go")) return false;
        const value = self.env_map.get("CO_TRANSLATOR_PREWARM_BACKEND") orelse return true;
        return !std.mem.eql(u8, value, "0") and !std.mem.eql(u8, value, "false");
    }

    fn prewarmBackend(self: *@This()) !void {
        if (!self.shouldPrewarmBackend()) return;
        if (self.backend_child != null) return;

        const allocator = std.heap.page_allocator;
        const go_backend_path = try backendExecutablePath(self.io, allocator, "co-translator-backend");
        defer allocator.free(go_backend_path);

        var child = std.process.spawn(self.io, .{
            .argv = &.{ go_backend_path, "--prewarm-exit" },
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| switch (err) {
            error.FileNotFound => return,
            else => return err,
        };
        _ = child.wait(self.io) catch {};
    }

    fn ensureBackendBridge(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        const bridge_token = try self.ensureBridgeToken();
        try self.ensureBackend();
        return std.fmt.bufPrint(output, "{{\"ok\":true,\"bridgeToken\":\"{s}\"}}", .{bridge_token});
    }

    fn prewarmBackendBridge(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        try self.prewarmBackend();
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }

    fn stopBackendBridge(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        self.stopBackend();
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }

    fn spawnBunBackend(self: *@This(), script_path: []const u8) !std.process.Child {
        return self.spawnBackend(&.{ "bun", "--smol", "--no-install", script_path });
    }

    fn spawnGoBackend(self: *@This(), executable_path: []const u8) !std.process.Child {
        return self.spawnBackend(&.{executable_path});
    }

    fn spawnNodeBackend(self: *@This(), script_path: []const u8) !std.process.Child {
        return self.spawnBackend(&.{ "node", "--max-old-space-size=32", "--max-semi-space-size=1", script_path });
    }

    fn spawnBackend(self: *@This(), argv: []const []const u8) !std.process.Child {
        return std.process.spawn(self.io, .{
            .argv = argv,
            .environ_map = self.env_map,
            .stdin = .ignore,
            .stdout = .inherit,
            .stderr = .inherit,
        });
    }

    fn ensureBridgeToken(self: *@This()) ![]const u8 {
        if (self.env_map.get("CO_TRANSLATOR_BRIDGE_TOKEN")) |token| {
            if (token.len > 0) return token;
        }
        if (!self.bridge_token_ready) {
            var raw: [32]u8 = undefined;
            self.io.randomSecure(&raw) catch self.io.random(&raw);
            self.bridge_token = std.fmt.bytesToHex(raw, .lower);
            self.bridge_token_ready = true;
            try self.env_map.put("CO_TRANSLATOR_BRIDGE_TOKEN", self.bridge_token[0..]);
        }
        return self.bridge_token[0..];
    }

    fn stopBackend(self: *@This()) void {
        if (self.backend_child) |*child| {
            child.kill(self.io);
            _ = child.wait(self.io) catch {};
            self.backend_child = null;
        }
    }
};

fn backendScriptPath(io: std.Io, allocator: std.mem.Allocator, filename: []const u8) ![]u8 {
    const project_path = try std.fs.path.join(allocator, &.{ "dist", "backend", filename });
    defer allocator.free(project_path);
    if (std.Io.Dir.cwd().statFile(io, project_path, .{})) |_| {
        return allocator.dupe(u8, project_path);
    } else |_| {}

    const exe_path = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(exe_path);
    const exe_dir = std.fs.path.dirname(exe_path) orelse ".";
    return std.fs.path.resolve(allocator, &.{ exe_dir, "..", "Resources", "dist", "renderer", "backend", filename });
}

fn backendExecutablePath(io: std.Io, allocator: std.mem.Allocator, filename: []const u8) ![]u8 {
    const project_path = try std.fs.path.join(allocator, &.{ "dist", "backend-go", filename });
    defer allocator.free(project_path);
    if (std.Io.Dir.cwd().statFile(io, project_path, .{})) |_| {
        return allocator.dupe(u8, project_path);
    } else |_| {}

    const exe_path = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(exe_path);
    const exe_dir = std.fs.path.dirname(exe_path) orelse ".";
    return std.fs.path.resolve(allocator, &.{ exe_dir, "..", "Resources", "dist", "renderer", "backend-go", filename });
}

const allowed_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "file://local",
    "http://127.0.0.1:5173",
};

fn rendererEntryUrl(io: std.Io, allocator: std.mem.Allocator) ![]u8 {
    const project_path = "dist/renderer/index.html";
    if (std.Io.Dir.cwd().statFile(io, project_path, .{})) |_| {
        return fileUrlFromPath(io, allocator, project_path);
    } else |_| {}

    const exe_path = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(exe_path);
    const exe_dir = std.fs.path.dirname(exe_path) orelse ".";
    const packaged_path = try std.fs.path.resolve(allocator, &.{ exe_dir, "..", "Resources", "dist", "renderer", "index.html" });
    defer allocator.free(packaged_path);
    return fileUrlFromPath(io, allocator, packaged_path);
}

fn fileUrlFromPath(io: std.Io, allocator: std.mem.Allocator, input_path: []const u8) ![]u8 {
    const absolute_path = if (std.fs.path.isAbsolute(input_path))
        try allocator.dupe(u8, input_path)
    else blk: {
        const cwd = try std.process.currentPathAlloc(io, allocator);
        defer allocator.free(cwd);
        break :blk try std.fs.path.resolve(allocator, &.{ cwd, input_path });
    };
    defer allocator.free(absolute_path);

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    try output.appendSlice(allocator, "file://");
    for (absolute_path) |byte| {
        switch (byte) {
            ' ' => try output.appendSlice(allocator, "%20"),
            '#' => try output.appendSlice(allocator, "%23"),
            '%' => try output.appendSlice(allocator, "%25"),
            '?' => try output.appendSlice(allocator, "%3F"),
            else => try output.append(allocator, byte),
        }
    }
    return output.toOwnedSlice(allocator);
}

pub fn main(init: std.process.Init) !void {
    var app = App{ .io = init.io, .env_map = init.environ_map };
    if (app.shouldEagerBackend()) try app.ensureBackend();
    const bridge_policies = [_]zero_native.BridgeCommandPolicy{
        .{
            .name = "coTranslator.ensureBackend",
            .origins = &.{ "zero://app", "zero://inline", "file://local", "http://127.0.0.1:5173" },
        },
        .{
            .name = "coTranslator.prewarmBackend",
            .origins = &.{ "zero://app", "zero://inline", "file://local", "http://127.0.0.1:5173" },
        },
        .{
            .name = "coTranslator.stopBackend",
            .origins = &.{ "zero://app", "zero://inline", "file://local", "http://127.0.0.1:5173" },
        },
    };
    const bridge_handlers = [_]zero_native.BridgeHandler{
        .{
            .name = "coTranslator.ensureBackend",
            .context = &app,
            .invoke_fn = App.ensureBackendBridge,
        },
        .{
            .name = "coTranslator.prewarmBackend",
            .context = &app,
            .invoke_fn = App.prewarmBackendBridge,
        },
        .{
            .name = "coTranslator.stopBackend",
            .context = &app,
            .invoke_fn = App.stopBackendBridge,
        },
    };
    try runner.runWithOptions(app.app(), .{
        .app_name = "Co Translator",
        .window_title = "Co Translator",
        .bundle_id = "com.cotranslator.desktop",
        .icon_path = "assets/icon.icns",
        .bridge = .{
            .policy = .{ .enabled = true, .commands = &bridge_policies },
            .registry = .{ .handlers = &bridge_handlers },
        },
        .security = .{
            .navigation = .{
                .allowed_origins = &allowed_origins,
                .external_links = .{
                    .action = .open_system_browser,
                    .allowed_urls = &.{ "https://platform.openai.com/*" },
                },
            },
        },
    }, init);
}

test "app name is configured" {
    try std.testing.expectEqualStrings("co-translator", "co-translator");
}
