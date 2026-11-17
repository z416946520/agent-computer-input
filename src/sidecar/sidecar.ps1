# agent-computer-input sidecar
# Windows PowerShell 5.1, STA. 一条 JSON 一行请求/响应（协议 v2）。
#
# 职责：UIA / 窗口消息 / 截图 / 低级键鼠钩子 / 暂停热键 / AI 光标覆盖层。
# 默认不碰真实光标和键盘焦点；physical 只在 ACI_ALLOW_PHYSICAL=1 时可用。
# AI 光标素材来自 assets/cursors/{light,dark}（由 Cur/ 下的 .cur/.ani 烘焙），
# 主题自动跟随 Windows 深浅色：浅色主题用深色光标，深色主题用浅色光标。
#
# 协议：请求 {v:2,id,cmd,...}；响应 {id,ok,result|error}；事件 {event:'ready'|'theme'|'log'}。

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

# ---------------------------------------------------------------- 初始配置
# 全部来自环境变量（Node 侧 spawn 时注入），运行中还能用 configure / set* 改。
$script:sidecarVersion = '0.3.0'

# AI 光标模式：companion = 一直陪着；clean = 用一下就收。
$script:cursorMode = if ($env:ACI_CURSOR_MODE -eq 'clean') { 'clean' } else { 'companion' }
$script:cursorHoldMs = 2600
if ($env:ACI_CURSOR_HOLD_MS) {
  try { $script:cursorHoldMs = [int]$env:ACI_CURSOR_HOLD_MS } catch { }
}

# AI 光标大小（像素，24–192）。素材按 manifest 里的 cell 等比最近邻缩放。
$script:cursorSize = 96
if ($env:ACI_CURSOR_SIZE) {
  try { $script:cursorSize = [int]$env:ACI_CURSOR_SIZE } catch { }
}
if ($script:cursorSize -lt 24) { $script:cursorSize = 24 }
if ($script:cursorSize -gt 192) { $script:cursorSize = 192 }

# 光标主题：auto = 跟随 Windows；light/dark = 强制（目录名按「给哪种主题用」命名）。
$script:cursorTheme = 'auto'
$script:cursorOpacity = 1.0
$script:animations = $true
if ($env:ACI_CURSOR_THEME) {
  $wanted = ([string]$env:ACI_CURSOR_THEME).ToLower()
  if ($wanted -eq 'light' -or $wanted -eq 'dark') { $script:cursorTheme = $wanted }
}
if ($env:ACI_CURSOR_OPACITY) {
  try {
    $v = [double]::Parse($env:ACI_CURSOR_OPACITY, [System.Globalization.CultureInfo]::InvariantCulture)
    if ($v -lt 0.2) { $v = 0.2 } elseif ($v -gt 1) { $v = 1 }
    $script:cursorOpacity = $v
  } catch { }
}
if ($env:ACI_ANIMATIONS -eq '0' -or $env:ACI_ANIMATIONS -eq 'false') { $script:animations = $false }

# 状态名：按操作自动切换，不用手选。
$script:styleNames = @('pointer','work','busy','unavailiable','link','text','cross','move','vert','horz','help','handwriting','dgn1','dgn2','alternate','person','pin')
$script:cursorStyle = 'pointer'
# 单次请求里的强制光标状态（action 传 cursorState 时覆盖自动推导）
$script:requestCursorState = $null

# 暂停热键（RegisterHotKey）；空串 = 不注册。
$script:hotkey = 'Ctrl+Alt+Q'
if ($env:ACI_HOTKEY) { $script:hotkey = [string]$env:ACI_HOTKEY }

# 是否允许 physical（真实鼠标 / 真实键盘）。默认禁止：会动真实光标、抢焦点。
$script:allowPhysical = $false
if ($env:ACI_ALLOW_PHYSICAL -eq '1' -or $env:ACI_ALLOW_PHYSICAL -eq 'true') { $script:allowPhysical = $true }

# 素材根目录（assets/cursors）：Node 侧通过 ACI_ASSETS 传来，缺省用脚本同级目录。
$script:assetsRoot = if ($env:ACI_ASSETS) { $env:ACI_ASSETS } else { Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'assets\cursors' }

# 先声明 DPI 感知，再加载 WinForms / UIA。否则高 DPI 屏上截图坐标和
# UIA FromPoint 会差一个缩放比，点不中目标。
$dpiCode = @'
using System;
using System.Runtime.InteropServices;
public static class AciDpiBootstrap {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Apply() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@
try { Add-Type -TypeDefinition $dpiCode; [AciDpiBootstrap]::Apply() } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:uia = $true
try {
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  $script:uia = $false
}

$refs = @(
  [System.Windows.Forms.Form].Assembly.Location,
  [System.Drawing.Bitmap].Assembly.Location,
  [System.Drawing.Point].Assembly.Location
)

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class AciInput
{
    public const int WH_KEYBOARD_LL = 13;
    public const int WH_MOUSE_LL = 14;

    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP = 0x0101;
    public const int WM_CHAR = 0x0102;
    public const uint WM_SETTEXT = 0x000C;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int WM_SYSKEYUP = 0x0105;
    public const int WM_MOUSEMOVE = 0x0200;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const int WM_LBUTTONDBLCLK = 0x0203;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP = 0x0205;
    public const int WM_RBUTTONDBLCLK = 0x0206;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_HOTKEY = 0x0312;
    public const int WM_QUIT = 0x0012;

    public const int MK_LBUTTON = 0x0001;
    public const int MK_RBUTTON = 0x0002;

    public const int GW_OWNER = 4;
    public const int GA_ROOT = 2;
    public const int GWL_STYLE = -16;

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    public const int SW_RESTORE = 9;
    public const int SWP_NOACTIVATE = 0x0010;
    public const int SWP_SHOWWINDOW = 0x0040;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    public const uint LLMHF_INJECTED = 0x00000001;
    public const uint LLKHF_INJECTED = 0x00000010;

    public const int MOD_ALT = 0x0001;
    public const int MOD_CONTROL = 0x0002;
    public const int MOD_NOREPEAT = 0x4000;
    public const int VK_MENU = 0x12;
    public const int VK_Q = 0x51;
    public static int HotkeyModifiers = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT;
    public static int HotkeyVk = VK_Q;
    public static string HotkeySpec = "Ctrl+Alt+Q";
    public static bool HotkeyEnabled = true;
    public const int HOTKEY_ID = 0x4453;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    public struct SIZE { public int cx; public int cy; public SIZE(int w, int h) { cx = w; cy = h; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr ChildWindowFromPointEx(IntPtr hWnd, POINT pt, uint flags);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
    [DllImport("user32.dll")]
    public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessageRaw(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessageText(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern IntPtr SetWindowLongPtrW(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    // 分层窗口（逐像素 alpha 覆盖层）
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);
    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] public static extern void CopyMemory(IntPtr destination, IntPtr source, IntPtr length);

    [StructLayout(LayoutKind.Sequential)]
    public struct RGBQUAD { public byte rgbBlue; public byte rgbGreen; public byte rgbRed; public byte rgbReserved; }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public RGBQUAD bmiColors;
    }

    static readonly DateTime StartTime = DateTime.UtcNow;
    static long lastUserInputTicks = 0;
    static long lastInjectedTick = 0;

    public static volatile bool Paused = false;
    public static volatile bool PhysicalActive = false;
    public static string PauseReason = "";
    public static int UserActiveMs = 800;
    static bool AllowPhysicalMouse = false;

    /// <summary>physical 开关（真实鼠标/键盘）。默认 false：会动真实光标、抢焦点。</summary>
    public static bool AllowPhysical
    {
        get { return AllowPhysicalMouse; }
        set { AllowPhysicalMouse = value; }
    }

    public static bool HotkeyThreadRunning
    {
        get { return hotkeyThread != null; }
    }

    static readonly object heldLock = new object();
    static readonly List<ushort> heldKeys = new List<ushort>();
    static bool leftDown = false;
    static bool rightDown = false;

    static POINT savedCursor;
    static bool hasSavedCursor = false;

    static IntPtr mouseHook = IntPtr.Zero;
    static IntPtr keyHook = IntPtr.Zero;
    static Thread hookThread = null;
    static uint hookThreadId = 0;
    static Thread hotkeyThread = null;
    static uint hotkeyThreadId = 0;
    static LowLevelProc mouseProc = MouseHookProc;
    static LowLevelProc keyProc = KeyHookProc;
    public static bool HotkeyRegistered = false;

    static AciInput()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }
        int size = Marshal.SizeOf(typeof(INPUT));
        if (IntPtr.Size == 8 && size != 40) throw new Exception("INPUT size " + size + " is not 40");
    }

    public static long LastUserInputAgeMs()
    {
        try
        {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (GetLastInputInfo(ref info))
            {
                uint now = (uint)(GetTickCount64() & 0xFFFFFFFF);
                return (long)((now - info.dwTime) & 0xFFFFFFFF);
            }
        }
        catch { }
        long last = Interlocked.Read(ref lastUserInputTicks);
        if (last == 0) return -1;
        return (long)((DateTime.UtcNow.Ticks - last) / TimeSpan.TicksPerMillisecond);
    }

    public static int[] CursorPos()
    {
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    public static void SetUserActiveMs(int ms)
    {
        if (ms < 0) ms = 0;
        UserActiveMs = ms;
    }

    static void TouchUserInput()
    {
        Interlocked.Exchange(ref lastUserInputTicks, DateTime.UtcNow.Ticks);
    }

    public static void SimulateUserInput()
    {
        TouchUserInput();
    }

    static IntPtr MouseHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((data.flags & LLMHF_INJECTED) == 0)
            {
                TouchUserInput();
            }
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    static IntPtr KeyHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((data.flags & LLKHF_INJECTED) == 0)
            {
                TouchUserInput();
            }
        }
        return CallNextHookEx(keyHook, nCode, wParam, lParam);
    }

    public static void StartHotkey()
    {
        if (hotkeyThread != null) return;
        hotkeyThread = new Thread(HotkeyThreadProc);
        hotkeyThread.IsBackground = true;
        hotkeyThread.SetApartmentState(ApartmentState.STA);
        hotkeyThread.Start();
    }

    /// <summary>换热键：先关旧线程再按新组合注册。mods=0 表示不注册。</summary>
    public static void SetHotkey(int mods, int vk, string spec)
    {
        HotkeyEnabled = mods > 0 && vk > 0;
        HotkeyModifiers = mods > 0 ? (mods | MOD_NOREPEAT) : 0;
        HotkeyVk = vk > 0 ? vk : VK_Q;
        HotkeySpec = spec == null ? "" : spec;
        StopHotkey();
        HotkeyRegistered = false;
        if (HotkeyEnabled) StartHotkey();
    }

    static void HotkeyThreadProc()
    {
        hotkeyThreadId = GetCurrentThreadId();
        try
        {
            HotkeyRegistered = HotkeyEnabled && RegisterHotKey(IntPtr.Zero, HOTKEY_ID, (uint)HotkeyModifiers, (uint)HotkeyVk);
        }
        catch { HotkeyRegistered = false; }
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.message == WM_HOTKEY && msg.wParam.ToInt32() == HOTKEY_ID)
            {
                TogglePause("hotkey");
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnregisterHotKey(IntPtr.Zero, HOTKEY_ID);
        hotkeyThreadId = 0;
    }

    public static void StopHotkey()
    {
        if (hotkeyThreadId != 0)
        {
            PostThreadMessage(hotkeyThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            hotkeyThreadId = 0;
        }
        hotkeyThread = null;
    }

    public static void StartHooks()
    {
        if (hookThread != null) return;
        hookThread = new Thread(HookThreadProc);
        hookThread.IsBackground = true;
        hookThread.SetApartmentState(ApartmentState.STA);
        hookThread.Start();
    }

    static void HookThreadProc()
    {
        hookThreadId = GetCurrentThreadId();
        IntPtr hmod = GetModuleHandle(null);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, hmod, 0);
        if (mouseHook == IntPtr.Zero) mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, IntPtr.Zero, 0);
        keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, hmod, 0);
        if (keyHook == IntPtr.Zero) keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, IntPtr.Zero, 0);

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (keyHook != IntPtr.Zero) { UnhookWindowsHookEx(keyHook); keyHook = IntPtr.Zero; }
        hookThreadId = 0;
    }

    public static void StopHooks()
    {
        if (hookThreadId != 0)
        {
            PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            hookThreadId = 0;
        }
        hookThread = null;
    }

    public static void TogglePause(string reason)
    {
        if (Paused) Resume();
        else Pause(reason);
    }

    public static void Pause(string reason)
    {
        Paused = true;
        PauseReason = reason;
        ReleaseAll();
        AciOverlay.SetPaused(true);
    }

    public static void Resume()
    {
        Paused = false;
        PauseReason = "";
        AciOverlay.SetPaused(false);
    }

    public static void ReleaseAll()
    {
        lock (heldLock)
        {
            for (int i = heldKeys.Count - 1; i >= 0; i--)
            {
                try { SendKeyRaw(heldKeys[i], false, false); } catch { }
            }
            heldKeys.Clear();
            if (leftDown) { try { SendMouseRaw(MOUSEEVENTF_LEFTUP, 0, 0, 0); } catch { } leftDown = false; }
            if (rightDown) { try { SendMouseRaw(MOUSEEVENTF_RIGHTUP, 0, 0, 0); } catch { } rightDown = false; }
        }
        RestoreCursor();
    }

    static void SaveCursor()
    {
        if (!hasSavedCursor)
        {
            POINT p;
            if (GetCursorPos(out p))
            {
                savedCursor = p;
                hasSavedCursor = true;
            }
        }
    }

    static void RestoreCursor()
    {
        if (hasSavedCursor)
        {
            try { SetCursorPos(savedCursor.X, savedCursor.Y); } catch { }
            hasSavedCursor = false;
        }
    }

    static void CheckReadyForPhysical()
    {
        // 主人和 AI 可以同时操作；只认显式暂停（Ctrl+Alt+Q / pause），
        // 不再因为检测到主人在动鼠标键盘就拒绝 physical。
        if (Paused) throw new Exception("paused: " + PauseReason);
    }

    static void MoveRaw(int x, int y)
    {
        int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int height = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        int nx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1));
        int ny = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1));
        SendMouseRaw(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0);
        Thread.Sleep(12);
    }

    static void SendMouseRaw(uint flags, int dx, int dy, int data)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = (uint)data;
        input.u.mi.dwFlags = flags;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        INPUT[] inputs = new INPUT[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("SendInput mouse failed");
        Interlocked.Exchange(ref lastInjectedTick, (long)(GetTickCount64() & 0xFFFFFFFF));
    }

    static void SendKeyRaw(ushort vk, bool down, bool extended)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = (down ? 0u : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0u);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        INPUT[] inputs = new INPUT[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("SendInput keyboard failed");
        Interlocked.Exchange(ref lastInjectedTick, (long)(GetTickCount64() & 0xFFFFFFFF));
    }

    static void SendUnicodeChar(char ch)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.u.ki.wVk = 0;
        down.u.ki.wScan = (ushort)ch;
        down.u.ki.dwFlags = KEYEVENTF_UNICODE;
        INPUT up = down;
        up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        INPUT[] inputs = new INPUT[] { down, up };
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2)
            throw new Exception("SendInput unicode failed");
        Interlocked.Exchange(ref lastInjectedTick, (long)(GetTickCount64() & 0xFFFFFFFF));
    }

    public static void PhysicalClick(int x, int y, bool right, int count)
    {
        if (!AllowPhysicalMouse) throw new Exception("physical-mouse-forbidden");
        if (count < 1) count = 1;
        CheckReadyForPhysical();
        StartHooks();
        SaveCursor();
        PhysicalActive = true;
        try
        {
            MoveRaw(x, y);
            for (int i = 0; i < count; i++)
            {
                if (Paused) throw new Exception("paused: " + PauseReason);
                if (right)
                {
                    SendMouseRaw(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0);
                    rightDown = true;
                    Thread.Sleep(30);
                    SendMouseRaw(MOUSEEVENTF_RIGHTUP, 0, 0, 0);
                    rightDown = false;
                }
                else
                {
                    SendMouseRaw(MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
                    leftDown = true;
                    Thread.Sleep(30);
                    SendMouseRaw(MOUSEEVENTF_LEFTUP, 0, 0, 0);
                    leftDown = false;
                }
                Thread.Sleep(80);
            }
        }
        finally
        {
            PhysicalActive = false;
            ReleaseAll();
            RestoreCursor();
            StopHooks();
        }
    }

    public static void PhysicalText(string text)
    {
        CheckReadyForPhysical();
        StartHooks();
        PhysicalActive = true;
        try
        {
            int i = 0;
            foreach (char ch in text)
            {
                if (Paused) throw new Exception("paused: " + PauseReason);
                SendUnicodeChar(ch);
                i++;
                if ((i % 24) == 0) Thread.Sleep(4);
            }
        }
        finally
        {
            PhysicalActive = false;
            StopHooks();
        }
    }

    public static void PhysicalKeySequence(ushort[] keys)
    {
        if (keys == null || keys.Length == 0) throw new Exception("keys required");
        CheckReadyForPhysical();
        StartHooks();
        PhysicalActive = true;
        try
        {
            lock (heldLock)
            {
                for (int i = 0; i < keys.Length; i++)
                {
                    if (Paused) throw new Exception("paused: " + PauseReason);
                    SendKeyRaw(keys[i], true, false);
                    heldKeys.Add(keys[i]);
                    Thread.Sleep(15);
                }
            }
            Thread.Sleep(35);
        }
        finally
        {
            PhysicalActive = false;
            ReleaseAll();
            StopHooks();
        }
    }

    public static void PhysicalScroll(int x, int y, int delta)
    {
        if (!AllowPhysicalMouse) throw new Exception("physical-mouse-forbidden");
        CheckReadyForPhysical();
        StartHooks();
        SaveCursor();
        PhysicalActive = true;
        try
        {
            MoveRaw(x, y);
            SendMouseRaw(MOUSEEVENTF_WHEEL, 0, 0, delta);
            Thread.Sleep(90);
        }
        finally
        {
            PhysicalActive = false;
            RestoreCursor();
            StopHooks();
        }
    }

    public static void PhysicalDrag(int x1, int y1, int x2, int y2, int durationMs)
    {
        if (!AllowPhysicalMouse) throw new Exception("physical-mouse-forbidden");
        CheckReadyForPhysical();
        StartHooks();
        SaveCursor();
        PhysicalActive = true;
        try
        {
            MoveRaw(x1, y1);
            SendMouseRaw(MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
            leftDown = true;
            int steps = Math.Max(8, Math.Min(80, durationMs / 16));
            for (int i = 1; i <= steps; i++)
            {
                if (Paused) throw new Exception("paused: " + PauseReason);
                int x = x1 + (x2 - x1) * i / steps;
                int y = y1 + (y2 - y1) * i / steps;
                MoveRaw(x, y);
                Thread.Sleep(16);
            }
            SendMouseRaw(MOUSEEVENTF_LEFTUP, 0, 0, 0);
            leftDown = false;
            Thread.Sleep(60);
        }
        finally
        {
            PhysicalActive = false;
            ReleaseAll();
            RestoreCursor();
            StopHooks();
        }
    }

    public static IntPtr FocusWindow(IntPtr hwnd)
    {
        IntPtr prev = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return prev;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        SendKeyRaw(VK_MENU, true, false);
        try { SetForegroundWindow(hwnd); }
        finally { SendKeyRaw(VK_MENU, false, false); }
        Thread.Sleep(70);
        return prev;
    }

    public static IntPtr GetFocusWindow()
    {
        GUITHREADINFO gti = new GUITHREADINFO();
        gti.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(0, ref gti))
        {
            if (gti.hwndFocus != IntPtr.Zero) return gti.hwndFocus;
            if (gti.hwndActive != IntPtr.Zero) return gti.hwndActive;
        }
        return GetForegroundWindow();
    }

    public static IntPtr WindowAt(int x, int y)
    {
        POINT p;
        p.X = x;
        p.Y = y;
        return WindowFromPoint(p);
    }

    public static IntPtr RootOf(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        IntPtr root = GetAncestor(hwnd, (uint)GA_ROOT);
        return root == IntPtr.Zero ? hwnd : root;
    }

    public static IntPtr ChildAt(IntPtr hwnd, int screenX, int screenY)
    {
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        POINT p;
        p.X = screenX;
        p.Y = screenY;
        if (!ScreenToClient(hwnd, ref p)) return hwnd;
        IntPtr child = ChildWindowFromPointEx(hwnd, p, 0x0001 | 0x0002);
        return child == IntPtr.Zero ? hwnd : child;
    }

    public static string WindowTitle(IntPtr hwnd)
    {
        int length = GetWindowTextLengthW(hwnd);
        if (length <= 0) return "";
        StringBuilder sb = new StringBuilder(length + 2);
        GetWindowTextW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string WindowClass(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetClassNameW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int WindowPid(IntPtr hwnd)
    {
        int pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }

    public static int[] WindowRect(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0)
        {
            if (!GetWindowRect(hwnd, out r)) return new int[] { 0, 0, 0, 0 };
        }
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static long WindowExStyle(IntPtr hwnd)
    {
        return (long)GetWindowLongPtrW(hwnd, -20);
    }

    public static IntPtr[] EnumTopWindows()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
        return list.ToArray();
    }

    public static void PostMouseClick(IntPtr hwnd, int x, int y, bool right, int count)
    {
        if (count < 1) count = 1;
        POINT p;
        p.X = x;
        p.Y = y;
        if (!ScreenToClient(hwnd, ref p)) throw new Exception("ScreenToClient failed");
        int lp = (p.Y << 16) | (p.X & 0xFFFF);
        uint down = right ? (uint)WM_RBUTTONDOWN : (uint)WM_LBUTTONDOWN;
        uint up = right ? (uint)WM_RBUTTONUP : (uint)WM_LBUTTONUP;
        uint dbl = right ? (uint)WM_RBUTTONDBLCLK : (uint)WM_LBUTTONDBLCLK;
        int mk = right ? MK_RBUTTON : MK_LBUTTON;
        PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, new IntPtr(lp));
        Thread.Sleep(8);
        for (int i = 0; i < count; i++)
        {
            uint msg = (i == 1) ? dbl : down;
            if (!PostMessage(hwnd, msg, new IntPtr(mk), new IntPtr(lp))) throw new Exception("PostMessage down failed");
            Thread.Sleep(28);
            if (!PostMessage(hwnd, up, IntPtr.Zero, new IntPtr(lp))) throw new Exception("PostMessage up failed");
            Thread.Sleep(55);
        }
    }

    public static void PostMouseScroll(IntPtr hwnd, int x, int y, int delta)
    {
        int lp = (y << 16) | (x & 0xFFFF);
        int wp = (delta << 16);
        if (!PostMessage(hwnd, WM_MOUSEWHEEL, new IntPtr(wp), new IntPtr(lp))) throw new Exception("PostMessage wheel failed");
    }

    public static void PostMouseDrag(IntPtr hwnd, int x1, int y1, int x2, int y2, int steps)
    {
        if (steps < 2) steps = 2;
        POINT a;
        a.X = x1;
        a.Y = y1;
        if (!ScreenToClient(hwnd, ref a)) throw new Exception("ScreenToClient failed");
        int lp1 = (a.Y << 16) | (a.X & 0xFFFF);
        PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, new IntPtr(lp1));
        PostMessage(hwnd, WM_LBUTTONDOWN, new IntPtr(MK_LBUTTON), new IntPtr(lp1));
        for (int i = 1; i <= steps; i++)
        {
            int sx = x1 + (x2 - x1) * i / steps;
            int sy = y1 + (y2 - y1) * i / steps;
            POINT p;
            p.X = sx;
            p.Y = sy;
            if (!ScreenToClient(hwnd, ref p)) continue;
            int lp = (p.Y << 16) | (p.X & 0xFFFF);
            PostMessage(hwnd, WM_MOUSEMOVE, new IntPtr(MK_LBUTTON), new IntPtr(lp));
            Thread.Sleep(16);
        }
        POINT b;
        b.X = x2;
        b.Y = y2;
        if (ScreenToClient(hwnd, ref b))
        {
            int lp2 = (b.Y << 16) | (b.X & 0xFFFF);
            PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, new IntPtr(lp2));
        }
    }

    public static void PostKey(IntPtr hwnd, int vk, bool down, bool extended, bool sys)
    {
        int scan = (int)MapVirtualKey((uint)vk, 0);
        int lParam = 1 | (scan << 16);
        if (extended) lParam |= (1 << 24);
        if (!down) lParam |= (1 << 30);
        if (!down) lParam |= unchecked((int)(1u << 31));
        uint msg = down ? (sys ? (uint)WM_SYSKEYDOWN : (uint)WM_KEYDOWN) : (sys ? (uint)WM_SYSKEYUP : (uint)WM_KEYUP);
        if (!PostMessage(hwnd, msg, new IntPtr(vk), new IntPtr(lParam))) throw new Exception("PostMessage key failed");
    }

    public static void PostText(IntPtr hwnd, string text)
    {
        foreach (char ch in text)
        {
            if (!PostMessage(hwnd, WM_CHAR, new IntPtr((int)ch), new IntPtr(1))) throw new Exception("PostMessage char failed");
            Thread.Sleep(2);
        }
    }

    public static string GetWindowText(IntPtr hwnd)
    {
        return WindowTitle(hwnd);
    }

    /// <summary>
    /// 读控件文本（跨进程）。不能用 GetWindowText/GetWindowTextLength：
    /// 对别的进程的控件它们只读缓存，返回空串。必须发 WM_GETTEXTLENGTH / WM_GETTEXT。
    /// </summary>
    public static string GetControlText(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return "";
        try
        {
            long len = (long)SendMessageRaw(hwnd, 0x000E, IntPtr.Zero, IntPtr.Zero); // WM_GETTEXTLENGTH
            int capacity = (int)len + 2;
            if (capacity < 4) capacity = 4;
            if (capacity > 65536) capacity = 65536;
            StringBuilder sb = new StringBuilder(capacity);
            SendMessageText(hwnd, 0x000D, (IntPtr)capacity, sb); // WM_GETTEXT
            return sb.ToString();
        }
        catch { return ""; }
    }

    public static bool SetTextMessage(IntPtr hwnd, string text)
    {
        SendMessageW(hwnd, WM_SETTEXT, IntPtr.Zero, text);
        return true;
    }

    public static string CapturePng(string path, int x, int y, int w, int h)
    {
        if (w <= 0 || h <= 0)
        {
            x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        }
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return path;
    }
}

public static class AciOverlay
{
    /// <summary>一个状态的光标素材：一张 sheet + 切帧参数 + 热点。</summary>
    public sealed class Sprite
    {
        public Image Image;
        public int Frames = 1;
        public int Cell = 128;
        public int Cols = 1;
        public int FrameDelayMs = 0;
        public int HotspotX = 0;
        public int HotspotY = 0;
    }

    static Thread thread = null;
    static OverlayForm form = null;
    static ManualResetEvent ready = new ManualResetEvent(false);
    static bool pausedState = false;
    public static bool LastSetWindowPosOk = false;
    public static int LastSetWindowPosError = 0;
    public static int LastX = 0;
    public static int LastY = 0;
    public static bool HasLast = false;

    static string cursorStyle = "pointer";
    static string cursorMode = "companion";
    static int cursorHoldMs = 2600;
    static int cursorSize = 96;
    static string cursorTheme = "auto";     // auto | light | dark（用户设置）
    static string scheme = "light";         // Windows 应用主题实际值
    static string activeTheme = "";          // 实际用的素材目录
    static double cursorOpacity = 1.0;
    static bool animations = true;
    static string assetRoot = "";

    public static readonly string[] StyleNames = {
        "pointer", "work", "busy", "unavailiable", "link", "text",
        "cross", "move", "vert", "horz", "help", "handwriting",
        "dgn1", "dgn2", "alternate", "person", "pin"
    };

    static readonly Dictionary<string, Dictionary<string, Sprite>> sets =
        new Dictionary<string, Dictionary<string, Sprite>>(StringComparer.OrdinalIgnoreCase);

    public static string Scheme { get { return scheme; } }
    public static string ActiveTheme { get { return activeTheme; } }
    public static string CursorThemeSetting { get { return cursorTheme; } }
    public static double Opacity { get { return cursorOpacity; } }
    public static bool Animations { get { return animations; } }
    public static int CursorSize { get { return cursorSize; } }
    public static string AssetRoot { get { return assetRoot; } }

    /* ---------------------------------------------------------------- 主题 */

    /// <summary>读 Windows「应用是否用浅色主题」：1 = 浅色，0 = 深色。</summary>
    public static string DetectScheme()
    {
        try
        {
            object value = Microsoft.Win32.Registry.GetValue(
                @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "AppsUseLightTheme", null);
            if (value != null)
            {
                int n;
                if (value is int) return ((int)value) == 0 ? "dark" : "light";
                if (int.TryParse(value.ToString(), out n)) return n == 0 ? "dark" : "light";
            }
        }
        catch { }
        return "light";
    }

    public static string NormalizeTheme(string theme)
    {
        string t = string.IsNullOrEmpty(theme) ? "auto" : theme.ToLowerInvariant();
        return (t == "light" || t == "dark") ? t : "auto";
    }

    /// <summary>用户设置 → 实际素材目录（auto 跟随系统）。</summary>
    public static string ResolveTheme()
    {
        scheme = DetectScheme();
        string resolved = (cursorTheme == "auto") ? scheme : cursorTheme;
        // 素材目录按「给哪种主题用」命名：浅色主题 → light 目录（深色光标）
        return resolved;
    }

    static int ClampSize(int size) { return Math.Max(24, Math.Min(192, size)); }
    static double ClampOpacity(double value) { return Math.Max(0.2, Math.Min(1.0, value)); }
    public static bool IsKnownStyle(string style)
    {
        string key = string.IsNullOrEmpty(style) ? "" : style.ToLowerInvariant();
        for (int i = 0; i < StyleNames.Length; i++) { if (StyleNames[i] == key) return true; }
        return false;
    }

    /// <summary>
    /// 载入一个主题的状态表。spec 每行：state|png路径|帧数|列数|格边|帧间隔ms|热点x|热点y
    /// （从 manifest.json 由 PowerShell 摊平，C# 不引 JSON 解析器）
    /// </summary>
    public static int LoadThemeSet(string theme, string spec)
    {
        Dictionary<string, Sprite> table = new Dictionary<string, Sprite>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrEmpty(spec))
        {
            string[] lines = spec.Replace("\r", "").Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0) continue;
                string[] parts = line.Split('|');
                if (parts.Length < 8) continue;
                string state = parts[0].Trim().ToLowerInvariant();
                string path = parts[1];
                if (!System.IO.File.Exists(path)) continue;
                try
                {
                    Sprite sprite = new Sprite();
                    sprite.Image = Image.FromFile(path);
                    sprite.Frames = Math.Max(1, int.Parse(parts[2]));
                    sprite.Cols = Math.Max(1, int.Parse(parts[3]));
                    sprite.Cell = Math.Max(1, int.Parse(parts[4]));
                    sprite.FrameDelayMs = Math.Max(0, int.Parse(parts[5]));
                    sprite.HotspotX = int.Parse(parts[6]);
                    sprite.HotspotY = int.Parse(parts[7]);
                    table[state] = sprite;
                }
                catch { }
            }
        }
        sets[theme] = table;
        return table.Count;
    }

    public static int ThemeSetCount(string theme)
    {
        Dictionary<string, Sprite> table;
        return sets.TryGetValue(theme, out table) ? table.Count : 0;
    }

    public static void Configure(string root, string theme, int size, double opacity, bool anims)
    {
        if (!string.IsNullOrEmpty(root)) assetRoot = root;
        cursorTheme = NormalizeTheme(theme);
        cursorSize = ClampSize(size);
        cursorOpacity = ClampOpacity(opacity);
        animations = anims;
        SwitchToResolved(ResolveTheme());
        if (form != null)
        {
            Run(delegate() { form.ApplySize(cursorSize); form.ApplyOpacity(cursorOpacity); form.ApplyAnimations(animations); }, 1200);
        }
    }

    static void SwitchToResolved(string theme)
    {
        if (string.IsNullOrEmpty(theme)) theme = "light";
        activeTheme = theme;
        if (form == null) return;
        Run(delegate() { form.LoadSprites(ResolveSet(activeTheme)); form.ApplyStyle(cursorStyle); }, 900);
    }

    static Dictionary<string, Sprite> ResolveSet(string theme)
    {
        Dictionary<string, Sprite> table;
        if (theme != null && sets.TryGetValue(theme, out table) && table.Count > 0) return table;
        if (sets.TryGetValue("light", out table) && table.Count > 0) return table;
        if (sets.TryGetValue("dark", out table) && table.Count > 0) return table;
        return new Dictionary<string, Sprite>(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 主题可以随时变（Windows 定时切换）。覆盖层自己 1.5s 检查一次，
    /// 变了就换图重画，不需要 Node 参与。
    /// </summary>
    public static void RefreshThemeIfNeeded()
    {
        string resolved = ResolveTheme();
        if (resolved == activeTheme) return;
        SwitchToResolved(resolved);
    }

    /* -------------------------------------------------------------- 生命周期 */

    public static void Start()
    {
        if (thread != null) return;
        scheme = DetectScheme();
        activeTheme = ResolveTheme();
        thread = new Thread(ThreadProc);
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ready.WaitOne(6000);
    }

    static void ThreadProc()
    {
        try
        {
            Application.EnableVisualStyles();
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                try { Console.Error.WriteLine("overlay: " + e.Exception); } catch { }
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                try { Console.Error.WriteLine("overlay fatal: " + e.ExceptionObject); } catch { }
            };
            form = new OverlayForm();
            form.LoadSprites(ResolveSet(activeTheme));
            form.ApplyStyle(cursorStyle);
            form.Paused = pausedState;
            form.ApplyMode(cursorMode, cursorHoldMs);
            form.ApplySize(cursorSize);
            form.ApplyOpacity(cursorOpacity);
            form.ApplyAnimations(animations);
            form.Location = new Point(-10000, -10000);
            form.Show();
            form.Hide();
            form.StartThemeWatch();
            ready.Set();
            try { Application.Run(); }
            catch (Exception ex) { try { Console.Error.WriteLine("overlay run: " + ex); } catch { } }
        }
        catch { ready.Set(); }
    }

    static bool Run(Action action, int timeoutMs)
    {
        if (form == null) return false;
        try
        {
            using (ManualResetEvent done = new ManualResetEvent(false))
            {
                form.BeginInvoke(new Action(delegate() { try { action(); } finally { done.Set(); } }));
                return done.WaitOne(timeoutMs);
            }
        }
        catch { return false; }
    }

    public static void ShowAt(int x, int y)
    {
        Start();
        LastX = x;
        LastY = y;
        HasLast = true;
        RefreshThemeIfNeeded();
        Run(delegate() { form.DisplayAt(x, y); }, 1200);
    }

    public static void SetMode(string mode, int holdMs)
    {
        cursorMode = (mode == "clean") ? "clean" : "companion";
        cursorHoldMs = holdMs > 0 ? holdMs : 2600;
        if (form == null) return;
        Run(delegate() { form.ApplyMode(cursorMode, cursorHoldMs); }, 500);
    }

    public static void SetSize(int size)
    {
        cursorSize = ClampSize(size);
        if (form == null) return;
        Run(delegate() { form.ApplySize(cursorSize); }, 1200);
    }

    public static void SetOpacity(double opacity)
    {
        cursorOpacity = ClampOpacity(opacity);
        if (form == null) return;
        Run(delegate() { form.ApplyOpacity(cursorOpacity); }, 600);
    }

    public static void SetAnimations(bool enabled)
    {
        animations = enabled;
        if (form == null) return;
        Run(delegate() { form.ApplyAnimations(animations); }, 600);
    }

    public static void SetTheme(string theme)
    {
        cursorTheme = NormalizeTheme(theme);
        SwitchToResolved(ResolveTheme());
    }

    public static void SetStyle(string style)
    {
        cursorStyle = IsKnownStyle(style) ? style.ToLowerInvariant() : "pointer";
        if (form == null) return;
        Run(delegate() { form.ApplyStyle(cursorStyle); }, 800);
    }

    public static void SetPaused(bool paused)
    {
        pausedState = paused;
        if (form == null) return;
        Run(delegate() { form.Paused = paused; }, 500);
    }

    public static void Hide()
    {
        if (form == null) return;
        Run(delegate() { form.HideNow(); }, 600);
    }

    public static bool VisibleNow()
    {
        if (form == null) return false;
        try { return form.Visible; } catch { return false; }
    }

    public static int[] Bounds()
    {
        if (form == null) return new int[] { 0, 0, 0, 0 };
        try { return new int[] { form.Left, form.Top, form.Width, form.Height }; } catch { return new int[] { 0, 0, 0, 0 }; }
    }

    public static int[] HotspotOffset()
    {
        if (form == null) return new int[] { 0, 0 };
        try { return form.CurrentHotspotOffset(); } catch { return new int[] { 0, 0 }; }
    }

    public static long HandleId()
    {
        if (form == null) return 0;
        try { return (long)form.Handle; } catch { return 0; }
    }

    public static void Stop()
    {
        if (form == null) return;
        Run(delegate() { form.HideNow(); Application.ExitThread(); }, 900);
    }

    sealed class OverlayForm : Form
    {
        readonly System.Windows.Forms.Timer animTimer;
        readonly System.Windows.Forms.Timer hideTimer;
        readonly System.Windows.Forms.Timer themeTimer;
        string mode = "companion";
        int holdMs = 2600;
        Sprite sprite;
        Dictionary<string, Sprite> sprites = new Dictionary<string, Sprite>(StringComparer.OrdinalIgnoreCase);
        string baseStyle = "pointer";
        int displaySize = 96;
        double opacity = 1.0;
        bool animations = true;
        int lastX = 0;
        int lastY = 0;
        int lastWindowX = 0;
        int lastWindowY = 0;
        int frame = 0;
        bool paused = false;
        Bitmap surface = null;

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(displaySize, displaySize);
            Visible = false;
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
            animTimer = new System.Windows.Forms.Timer();
            animTimer.Interval = 90;
            animTimer.Tick += delegate
            {
                if (sprite != null && sprite.Frames > 1 && animations)
                {
                    frame = (frame + 1) % sprite.Frames;
                    RenderLayered();
                }
            };
            hideTimer = new System.Windows.Forms.Timer();
            hideTimer.Tick += delegate { hideTimer.Stop(); HideNow(); };
            themeTimer = new System.Windows.Forms.Timer();
            themeTimer.Interval = 1500;
            themeTimer.Tick += delegate
            {
                try
                {
                    string resolved = AciOverlay.ResolveTheme();
                    if (resolved != AciOverlay.activeTheme)
                    {
                        AciOverlay.activeTheme = resolved;
                        LoadSprites(AciOverlay.ResolveSet(resolved));
                        ApplyStyle(baseStyle);
                        if (Visible) RenderLayered();
                    }
                }
                catch { }
            };
        }

        public void StartThemeWatch() { themeTimer.Start(); }

        public void ApplyMode(string m, int h)
        {
            mode = (m == "clean") ? "clean" : "companion";
            holdMs = h > 0 ? h : 2600;
            if (mode == "clean" && Visible)
            {
                hideTimer.Stop();
                hideTimer.Interval = holdMs;
                hideTimer.Start();
            }
            else
            {
                hideTimer.Stop();
            }
        }

        public void LoadSprites(Dictionary<string, Sprite> table)
        {
            sprites = table != null ? table : new Dictionary<string, Sprite>(StringComparer.OrdinalIgnoreCase);
            if (!sprites.ContainsKey(baseStyle))
            {
                string first = null;
                foreach (string key in sprites.Keys) { first = key; break; }
                baseStyle = first != null ? first : "pointer";
            }
            if (sprites.ContainsKey(baseStyle)) ApplySprite(sprites[baseStyle]);
        }

        public void ApplyStyle(string style)
        {
            if (sprites == null || sprites.Count == 0) return;
            string key = string.IsNullOrEmpty(style) ? "pointer" : style.ToLowerInvariant();
            if (!sprites.ContainsKey(key)) key = sprites.ContainsKey("pointer") ? "pointer" : baseStyle;
            baseStyle = key;
            if (!paused && sprites.ContainsKey(key)) ApplySprite(sprites[key]);
        }

        void ApplySprite(Sprite next)
        {
            if (next == null || next.Image == null) return;
            sprite = next;
            frame = 0;
            if (animations && next.Frames > 1)
            {
                animTimer.Interval = Math.Max(40, next.FrameDelayMs > 0 ? next.FrameDelayMs : 90);
                animTimer.Start();
            }
            else
            {
                animTimer.Stop();
            }
            if (Visible) RenderLayered();
        }

        public void ApplySize(int size)
        {
            size = Math.Max(24, Math.Min(192, size));
            displaySize = size;
            Size = new Size(size, size);
            if (surface != null) { surface.Dispose(); surface = null; }
            if (Visible) RenderLayered();
        }

        public void ApplyOpacity(double value)
        {
            opacity = Math.Max(0.2, Math.Min(1.0, value));
            if (Visible) RenderLayered();
        }

        public void ApplyAnimations(bool enabled)
        {
            animations = enabled;
            if (!enabled) animTimer.Stop();
            if (sprite != null) ApplySprite(sprite);
        }

        /// <summary>素材热点（箭头尖/十字中心）→ 窗口左上角要减掉的像素。</summary>
        public int[] CurrentHotspotOffset()
        {
            if (sprite == null || sprite.Cell <= 0) return new int[] { 0, 0 };
            double scale = displaySize / (double)sprite.Cell;
            return new int[]
            {
                (int)Math.Round(sprite.HotspotX * scale),
                (int)Math.Round(sprite.HotspotY * scale)
            };
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00080000; // WS_EX_LAYERED：整窗逐像素 alpha，不再靠 color key
                cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT（点击穿透）
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE（不抢焦点）
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                return cp;
            }
        }

        /// <summary>
        /// 用 UpdateLayeredWindow 画：预乘 alpha 的 32bpp 位图直接交给 DWM，
        /// 边缘干净、没有 color key 的洋红光晕，透明度也不需要分层两次。
        /// </summary>
        void RenderLayered()
        {
            if (!IsHandleCreated) return;
            int size = Math.Max(8, displaySize);
            if (surface == null || surface.Width != size || surface.Height != size)
            {
                if (surface != null) surface.Dispose();
                surface = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            }
            using (Graphics g = Graphics.FromImage(surface))
            {
                g.Clear(Color.Transparent);
                g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceOver;
                g.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighSpeed;
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                bool drawn = false;
                if (sprite != null && sprite.Image != null)
                {
                    int cols = Math.Max(1, sprite.Cols);
                    int cell = Math.Max(1, sprite.Cell);
                    int frames = Math.Max(1, sprite.Frames);
                    int index = Math.Min(Math.Max(0, frame), frames - 1);
                    int col = index % cols;
                    int row = index / cols;
                    if ((row + 1) * cell <= sprite.Image.Height && (col + 1) * cell <= sprite.Image.Width)
                    {
                        g.DrawImage(sprite.Image, new Rectangle(0, 0, size, size),
                            new Rectangle(col * cell, row * cell, cell, cell), GraphicsUnit.Pixel);
                        drawn = true;
                    }
                }
                if (!drawn)
                {
                    // 素材缺失时的兜底：一个环 + 圆点，至少能看见落点
                    using (Pen pen = new Pen(Paused ? Color.Orange : Color.DeepSkyBlue, 3))
                    {
                        g.DrawEllipse(pen, 8, 8, size - 17, size - 17);
                    }
                    using (SolidBrush dot = new SolidBrush(Color.White))
                    {
                        g.FillEllipse(dot, size / 2 - 3, size / 2 - 3, 6, 6);
                    }
                }
            }

            int[] off = CurrentHotspotOffset();
            lastWindowX = lastX - off[0];
            lastWindowY = lastY - off[1];

            IntPtr screenDc = AciInput.GetDC(IntPtr.Zero);
            IntPtr memDc = AciInput.CreateCompatibleDC(screenDc);
            IntPtr dib = IntPtr.Zero;
            try
            {
                // 关键：必须用自建 32bpp DIB 把预乘 alpha 原样交给 ULW。
                // 用 Bitmap.GetHbitmap() 会丢 alpha（半透明边缘变成硬边白边）。
                System.Drawing.Imaging.BitmapData bits = surface.LockBits(
                    new Rectangle(0, 0, size, size),
                    System.Drawing.Imaging.ImageLockMode.ReadOnly,
                    System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
                try
                {
                    AciInput.BITMAPINFO info = new AciInput.BITMAPINFO();
                    info.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(AciInput.BITMAPINFOHEADER));
                    info.bmiHeader.biWidth = size;
                    info.bmiHeader.biHeight = -size; // top-down
                    info.bmiHeader.biPlanes = 1;
                    info.bmiHeader.biBitCount = 32;
                    info.bmiHeader.biCompression = 0;
                    info.bmiHeader.biSizeImage = (uint)(size * size * 4);
                    IntPtr pixels;
                    dib = AciInput.CreateDIBSection(memDc, ref info, 0, out pixels, IntPtr.Zero, 0);
                    if (dib == IntPtr.Zero) throw new Exception("CreateDIBSection failed: " + Marshal.GetLastWin32Error());
                    AciInput.CopyMemory(pixels, bits.Scan0, (IntPtr)(size * size * 4));
                }
                finally
                {
                    surface.UnlockBits(bits);
                }

                IntPtr oldObject = AciInput.SelectObject(memDc, dib);
                try
                {
                    AciInput.POINT dst = new AciInput.POINT();
                    dst.X = lastWindowX;
                    dst.Y = lastWindowY;
                    AciInput.SIZE sizeInfo = new AciInput.SIZE(size, size);
                    AciInput.POINT src = new AciInput.POINT();
                    src.X = 0;
                    src.Y = 0;
                    AciInput.BLENDFUNCTION blend = new AciInput.BLENDFUNCTION();
                    blend.BlendOp = 0;
                    blend.BlendFlags = 0;
                    blend.SourceConstantAlpha = (byte)Math.Round(opacity * 255);
                    blend.AlphaFormat = 1; // AC_SRC_ALPHA
                    bool ok = AciInput.UpdateLayeredWindow(Handle, screenDc, ref dst, ref sizeInfo, memDc, ref src, 0, ref blend, 2);
                    AciOverlay.LastSetWindowPosOk = ok;
                    AciOverlay.LastSetWindowPosError = Marshal.GetLastWin32Error();
                }
                finally
                {
                    AciInput.SelectObject(memDc, oldObject);
                }
            }
            finally
            {
                if (dib != IntPtr.Zero) AciInput.DeleteObject(dib);
                AciInput.DeleteDC(memDc);
                AciInput.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        public bool Paused
        {
            get { return paused; }
            set
            {
                paused = value;
                if (sprites == null) return;
                if (paused && sprites.ContainsKey("unavailiable")) ApplySprite(sprites["unavailiable"]);
                else if (sprites.ContainsKey(baseStyle)) ApplySprite(sprites[baseStyle]);
            }
        }

        public void DisplayAt(int x, int y)
        {
            lastX = x;
            lastY = y;
            if (!Visible) Show();
            TopMost = false;
            TopMost = true;
            RenderLayered();
            frame = 0;
            hideTimer.Stop();
            if (mode == "clean")
            {
                hideTimer.Interval = holdMs;
                hideTimer.Start();
            }
        }

        public void HideNow()
        {
            hideTimer.Stop();
            animTimer.Stop();
            Hide();
        }
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies $refs

# ---------------------------------------------------------------- UIA helpers

function Get-UiaElementAt([int]$x, [int]$y) {
  if (-not $script:uia) { return $null }
  try {
    $pt = [System.Windows.Point]::new([double]$x, [double]$y)
    return [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  } catch { return $null }
}

function Get-UiaName($el) {
  try { return [string]$el.Current.Name } catch { return '' }
}

function Get-UiaType($el) {
  try { return [string]$el.Current.ControlType.ProgrammaticName } catch { return '' }
}

function Invoke-UiaClick([int]$x, [int]$y) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cur = $el
  for ($i = 0; $i -lt 6 -and $null -ne $cur; $i++) {
    $n = Get-UiaName $cur
    $t = Get-UiaType $cur
    try {
      $p = $cur.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $p.Invoke()
      return @{ ok = $true; via = 'uia'; pattern = 'Invoke'; name = $n; type = $t }
    } catch { }
    try {
      $p = $cur.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $p.Toggle()
      return @{ ok = $true; via = 'uia'; pattern = 'Toggle'; name = $n; type = $t }
    } catch { }
    try {
      $p = $cur.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $p.Select()
      return @{ ok = $true; via = 'uia'; pattern = 'Select'; name = $n; type = $t }
    } catch { }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
  }
  return @{ ok = $false; reason = 'uia-no-pattern'; name = $name; type = $type }
}

function Invoke-UiaClickInWindow([IntPtr]$hwnd, [int]$x, [int]$y) {
  if (-not $script:uia -or $hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; reason = 'uia-no-window' } }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) { return @{ ok = $false; reason = 'uia-no-window' } }
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $limit = [Math]::Min($all.Count, 4000)
    for ($i = 0; $i -lt $limit; $i++) {
      $cur = $all.Item($i)
      try {
        $r = $cur.Current.BoundingRectangle
        if ($r.IsEmpty) { continue }
        if ($x -lt $r.Left -or $x -gt $r.Right -or $y -lt $r.Top -or $y -gt $r.Bottom) { continue }
      } catch { continue }
      $n = Get-UiaName $cur
      $t = Get-UiaType $cur
      try {
        $p = $cur.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $p.Invoke()
        return @{ ok = $true; via = 'uia-hwnd'; pattern = 'Invoke'; name = $n; type = $t }
      } catch { }
      try {
        $p = $cur.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $p.Toggle()
        return @{ ok = $true; via = 'uia-hwnd'; pattern = 'Toggle'; name = $n; type = $t }
      } catch { }
      try {
        $p = $cur.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $p.Select()
        return @{ ok = $true; via = 'uia-hwnd'; pattern = 'Select'; name = $n; type = $t }
      } catch { }
    }
  } catch { }
  return @{ ok = $false; reason = 'uia-no-element' }
}

function Set-UiaTextInWindow([IntPtr]$hwnd, [string]$text, [bool]$replace) {
  if (-not $script:uia -or $hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; reason = 'uia-no-window' } }
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($replace) { $vp.SetValue($text) }
    else { $vp.SetValue([string]$vp.Current.Value + $text) }
    return @{ ok = $true; via = 'uia-hwnd'; pattern = 'Value'; name = (Get-UiaName $el); type = (Get-UiaType $el) }
  } catch {
    return @{ ok = $false; reason = 'uia-no-value' }
  }
}

function Set-UiaText([int]$x, [int]$y, [string]$text, [bool]$replace) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($replace) { $vp.SetValue($text) }
    else { $vp.SetValue([string]$vp.Current.Value + $text) }
    return @{ ok = $true; via = 'uia'; pattern = 'Value'; name = $name; type = $type }
  } catch { }
  try {
    $legacy = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $legacy.SetValue($text)
    return @{ ok = $true; via = 'uia'; pattern = 'LegacyValue'; name = $name; type = $type }
  } catch { }
  return @{ ok = $false; reason = 'uia-no-value'; name = $name; type = $type }
}

function Set-UiaFocus([int]$x, [int]$y) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  try {
    $el.SetFocus()
    return @{ ok = $true; via = 'uia'; pattern = 'Focus'; name = $name; type = $type }
  } catch {
    return @{ ok = $false; reason = 'uia-no-focus'; name = $name; type = $type }
  }
}

function Invoke-UiaScroll([int]$x, [int]$y, [int]$delta) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  $amount = if ($delta -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
  try {
    $sp = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $amount)
    return @{ ok = $true; via = 'uia'; pattern = 'Scroll'; name = $name; type = $type }
  } catch { }
  try {
    $si = $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
    $si.ScrollIntoView()
    return @{ ok = $true; via = 'uia'; pattern = 'ScrollItem'; name = $name; type = $type }
  } catch { }
  return @{ ok = $false; reason = 'uia-no-scroll'; name = $name; type = $type }
}

# ---------------------------------------------------------------- window list

function Get-WindowsList {
  $result = @()
  $foreground = [long][AciInput]::GetForegroundWindow()
  foreach ($h in [AciInput]::EnumTopWindows()) {
    try {
      if (-not [AciInput]::IsWindowVisible($h)) { continue }
      $title = [AciInput]::WindowTitle($h)
      if ([string]::IsNullOrWhiteSpace($title)) { continue }
      $pid2 = [AciInput]::WindowPid($h)
      $procName = ''
      try { $procName = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { }
      $rect = [AciInput]::WindowRect($h)
      $result += @{
        hwnd = [long]$h
        title = $title
        className = [AciInput]::WindowClass($h)
        process = $procName
        pid = $pid2
        rect = @{ x = $rect[0]; y = $rect[1]; w = $rect[2]; h = $rect[3] }
        foreground = ([long]$h -eq $foreground)
        iconic = [AciInput]::IsIconic($h)
      }
    } catch { }
  }
  return ,$result
}

# ---------------------------------------------------------------- keyboard map

function Get-Vk([string]$name) {
  $n = $name.Trim().ToLower()
  switch ($n) {
    'ctrl' { return 0x11 }
    'control' { return 0x11 }
    'shift' { return 0x10 }
    'alt' { return 0x12 }
    'menu' { return 0x12 }
    'win' { return 0x5B }
    'lwin' { return 0x5B }
    'rwin' { return 0x5C }
    'enter' { return 0x0D }
    'return' { return 0x0D }
    'esc' { return 0x1B }
    'escape' { return 0x1B }
    'tab' { return 0x09 }
    'space' { return 0x20 }
    'backspace' { return 0x08 }
    'delete' { return 0x2E }
    'del' { return 0x2E }
    'insert' { return 0x2D }
    'ins' { return 0x2D }
    'home' { return 0x24 }
    'end' { return 0x23 }
    'pageup' { return 0x21 }
    'pagedown' { return 0x22 }
    'up' { return 0x26 }
    'down' { return 0x28 }
    'left' { return 0x25 }
    'right' { return 0x27 }
    'capslock' { return 0x14 }
    'numlock' { return 0x90 }
    'printscreen' { return 0x2C }
    'scrolllock' { return 0x91 }
    'pause' { return 0x13 }
    'apps' { return 0x5D }
    default {
      if ($n.Length -eq 1) { return [int][char]$n.ToUpper() }
      if ($n -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
      throw "unknown key: $name"
    }
  }
}

# ---------------------------------------------------------------- status

function Get-StatusResult {
  $cursor = [AciInput]::CursorPos()
  $fg = [AciInput]::GetForegroundWindow()
  $fgTitle = ''
  try { $fgTitle = [AciInput]::WindowTitle($fg) } catch { }
  return @{
    paused = [AciInput]::Paused
    pauseReason = [AciInput]::PauseReason
    lastUserInputAgeMs = [AciInput]::LastUserInputAgeMs()
    cursor = @{ x = $cursor[0]; y = $cursor[1] }
    foreground = @{
      hwnd = [long]$fg
      title = $fgTitle
      className = [AciInput]::WindowClass($fg)
      pid = [AciInput]::WindowPid($fg)
    }
    overlay = [AciOverlay]::VisibleNow()
    overlayRect = [AciOverlay]::Bounds()
    overlayHwnd = [AciOverlay]::HandleId()
    overlayOffset = [AciOverlay]::HotspotOffset()
    hotkey = if ([AciInput]::HotkeyEnabled) { [AciInput]::HotkeySpec } else { '' }
    hotkeyRegistered = [AciInput]::HotkeyRegistered
    uia = $script:uia
    cursorMode = $script:cursorMode
    cursorHoldMs = $script:cursorHoldMs
    cursorSize = $script:cursorSize
    cursorStyle = $script:cursorStyle
    cursorState = if ([AciInput]::Paused) { 'unavailiable' } else { $script:cursorStyle }
    cursorTheme = [AciOverlay]::CursorThemeSetting
    theme = [AciOverlay]::Scheme
    activeCursorTheme = [AciOverlay]::ActiveTheme
    cursorOpacity = [AciOverlay]::Opacity
    animations = [AciOverlay]::Animations
    cursorStates = $script:styleNames
    physicalAllowed = $script:allowPhysical
    assetRoot = [AciOverlay]::AssetRoot
    version = $script:sidecarVersion
    userActiveMs = [AciInput]::UserActiveMs
  }
}

function Get-PausedResult {
  if (-not [AciInput]::Paused) { return $null }
  return @{
    ok = $false
    paused = $true
    reason = 'paused'
    note = '主人已经暂停/接管输入。不要继续操作；等主人说继续，再调用 action:"resume"。'
  }
}

function Show-StateAt([string]$state, [int]$x, [int]$y) {
  if ($script:requestCursorState -and ($script:styleNames -contains $script:requestCursorState)) {
    $state = $script:requestCursorState
  }
  if ($state -and ($script:styleNames -contains $state)) { $script:cursorStyle = $state }
  [AciOverlay]::SetStyle($script:cursorStyle)
  [AciOverlay]::ShowAt($x, $y)
}

function Set-HotkeyFromSpec([string]$spec) {
  $script:hotkey = $spec
  if ([string]::IsNullOrWhiteSpace($spec)) {
    [AciInput]::SetHotkey(0, 0, '')
    return $false
  }
  $parts = @($spec -split '\+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($parts.Count -eq 0) { [AciInput]::SetHotkey(0, 0, ''); return $false }
  $mods = 0
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    switch ($parts[$i].Trim().ToLower()) {
      'ctrl' { $mods = $mods -bor 0x0002 }
      'control' { $mods = $mods -bor 0x0002 }
      'alt' { $mods = $mods -bor 0x0001 }
      'shift' { $mods = $mods -bor 0x0004 }
      'win' { $mods = $mods -bor 0x0008 }
      default { }
    }
  }
  $keyName = $parts[$parts.Count - 1].Trim()
  $vk = 0
  try { $vk = [int](Get-Vk $keyName) } catch { $vk = 0 }
  if ($vk -le 0) { [AciInput]::SetHotkey(0, 0, ''); return $false }
  [AciInput]::SetHotkey($mods, $vk, $spec)
  return $true
}

# ---------------------------------------------------------------- requests

function Invoke-Request($req) {
  $cmd = [string]$req.cmd

  switch ($cmd) {
    'ping' { return @{ pong = $true } }
    'status' { return Get-StatusResult }
    'setCursorMode' {
      $m = [string]$req.mode
      if ($m -eq 'clean' -or $m -eq 'companion') { $script:cursorMode = $m }
      if ($null -ne $req.holdMs) { $script:cursorHoldMs = [int]$req.holdMs }
      [AciOverlay]::SetMode($script:cursorMode, $script:cursorHoldMs)
      return @{ ok = $true; cursorMode = $script:cursorMode; cursorHoldMs = $script:cursorHoldMs }
    }
    'setCursorSize' {
      $s = [int]$req.size
      if ($s -ge 24 -and $s -le 192) { $script:cursorSize = $s }
      [AciOverlay]::SetSize($script:cursorSize)
      return @{ ok = $true; cursorSize = $script:cursorSize }
    }
    'setCursorStyle' {
      $s = ([string]$req.style).ToLower()
      if ($script:styleNames -contains $s) { $script:cursorStyle = $s }
      [AciOverlay]::SetStyle($script:cursorStyle)
      return @{ ok = $true; cursorStyle = $script:cursorStyle; styles = $script:styleNames }
    }
    'setCursorTheme' {
      $t = ([string]$req.theme).ToLower()
      if ($t -eq 'light' -or $t -eq 'dark' -or $t -eq 'auto') { $script:cursorTheme = $t }
      [AciOverlay]::SetTheme($script:cursorTheme)
      return @{
        ok = $true; cursorTheme = [AciOverlay]::CursorThemeSetting
        theme = [AciOverlay]::Scheme; activeCursorTheme = [AciOverlay]::ActiveTheme
      }
    }
    'setCursorOpacity' {
      $v = 1.0
      try { $v = [double]$req.opacity } catch { }
      [AciOverlay]::SetOpacity($v)
      $script:cursorOpacity = [AciOverlay]::Opacity
      return @{ ok = $true; cursorOpacity = $script:cursorOpacity }
    }
    'setAnimations' {
      $script:animations = [bool]$req.enabled
      [AciOverlay]::SetAnimations($script:animations)
      return @{ ok = $true; animations = $script:animations }
    }
    'setHotkey' {
      $ok = Set-HotkeyFromSpec ([string]$req.hotkey)
      return @{ ok = $true; hotkey = $script:hotkey; hotkeyApplied = $ok; hotkeyRegistered = [AciInput]::HotkeyRegistered }
    }
    'setAllowPhysical' {
      $script:allowPhysical = [bool]$req.allow
      [AciInput]::AllowPhysical = $script:allowPhysical
      return @{ ok = $true; physicalAllowed = $script:allowPhysical }
    }
    'reloadAssets' {
      $loaded = Import-CursorAssets
      [AciOverlay]::SetTheme($script:cursorTheme)
      return @{ ok = $true; themes = $loaded }
    }
    'configure' {
      if ($null -ne $req.cursorMode) {
        $m = [string]$req.cursorMode
        if ($m -eq 'clean' -or $m -eq 'companion') { $script:cursorMode = $m }
      }
      if ($null -ne $req.cursorHoldMs) { $script:cursorHoldMs = [int]$req.cursorHoldMs }
      if ($null -ne $req.cursorSize) {
        $s = [int]$req.cursorSize
        if ($s -ge 24 -and $s -le 192) { $script:cursorSize = $s }
      }
      if ($null -ne $req.cursorTheme) {
        $t = ([string]$req.cursorTheme).ToLower()
        if ($t -eq 'light' -or $t -eq 'dark' -or $t -eq 'auto') { $script:cursorTheme = $t }
      }
      if ($null -ne $req.cursorOpacity) {
        try { $script:cursorOpacity = [double]$req.cursorOpacity } catch { }
      }
      if ($null -ne $req.animations) { $script:animations = [bool]$req.animations }
      if ($null -ne $req.allowPhysical) {
        $script:allowPhysical = [bool]$req.allowPhysical
        [AciInput]::AllowPhysical = $script:allowPhysical
      }
      if ($null -ne $req.hotkey) { Set-HotkeyFromSpec ([string]$req.hotkey) | Out-Null }

      [AciOverlay]::Configure($script:assetsRoot, $script:cursorTheme, $script:cursorSize, $script:cursorOpacity, $script:animations)
      [AciOverlay]::SetMode($script:cursorMode, $script:cursorHoldMs)
      return @{
        ok = $true; cursorMode = $script:cursorMode; cursorHoldMs = $script:cursorHoldMs
        cursorSize = $script:cursorSize; cursorTheme = [AciOverlay]::CursorThemeSetting
        cursorOpacity = [AciOverlay]::Opacity; animations = [AciOverlay]::Animations
        theme = [AciOverlay]::Scheme; activeCursorTheme = [AciOverlay]::ActiveTheme
        hotkey = $script:hotkey; hotkeyRegistered = [AciInput]::HotkeyRegistered
        physicalAllowed = $script:allowPhysical
      }
    }
    'simulateUserInput' {
      [AciInput]::SimulateUserInput()
      return Get-StatusResult
    }
    'debug' {
      $h = [AciOverlay]::HandleId()
      $hr = @(0, 0, 0, 0)
      $vis = $false
      $ex = 0
      if ($h -ne 0) {
        $hr = [AciInput]::WindowRect([IntPtr]$h)
        $vis = [AciInput]::IsWindowVisible([IntPtr]$h)
        $ex = [AciInput]::WindowExStyle([IntPtr]$h)
      }
      return @{
        hwnd = $h
        visible = $vis
        rect = $hr
        bounds = [AciOverlay]::Bounds()
        exStyle = ('0x{0:X}' -f $ex)
        style = if ($h -ne 0) { '0x{0:X}' -f ([long][AciInput]::GetWindowLongPtrW([IntPtr]$h, -16)) } else { '0x0' }
        parent = if ($h -ne 0) { [long][AciInput]::GetParent([IntPtr]$h) } else { 0 }
        root = if ($h -ne 0) { [long][AciInput]::RootOf([IntPtr]$h) } else { 0 }
        topmost = (($ex -band 0x8) -ne 0)
        transparent = (($ex -band 0x20) -ne 0)
        noactivate = (($ex -band 0x08000000) -ne 0)
        toolwindow = (($ex -band 0x80) -ne 0)
        setWindowPosOk = [AciOverlay]::LastSetWindowPosOk
        setWindowPosError = [AciOverlay]::LastSetWindowPosError
      }
    }
    'windows' { return @{ windows = (Get-WindowsList) } }
    'windowAt' {
      $h = [AciInput]::WindowAt([int]$req.x, [int]$req.y)
      return @{
        hwnd = [long]$h
        title = [AciInput]::WindowTitle($h)
        className = [AciInput]::WindowClass($h)
        root = [long][AciInput]::RootOf($h)
      }
    }
    'uiaInfo' {
      $el = Get-UiaElementAt ([int]$req.x) ([int]$req.y)
      if ($null -eq $el) { return @{ ok = $false; reason = 'null' } }
      $r = $el.Current.BoundingRectangle
      return @{
        ok = $true
        name = (Get-UiaName $el)
        type = (Get-UiaType $el)
        className = [string]$el.Current.ClassName
        rect = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
      }
    }
    'winInfo' {
      $h = [IntPtr][long]$req.hwnd
      $r = [AciInput]::WindowRect($h)
      return @{
        hwnd = [long]$h
        title = [AciInput]::WindowTitle($h)
        className = [AciInput]::WindowClass($h)
        visible = [AciInput]::IsWindowVisible($h)
        iconic = [AciInput]::IsIconic($h)
        rect = @{ x = $r[0]; y = $r[1]; w = $r[2]; h = $r[3] }
        foreground = ([long][AciInput]::GetForegroundWindow() -eq [long]$h)
      }
    }
    'setUserActiveMs' {
      [AciInput]::SetUserActiveMs([int]$req.ms)
      return Get-StatusResult
    }
    'move' {
      $x = [int]$req.x
      $y = [int]$req.y
      Show-StateAt 'pointer' $x $y
      return @{
        ok = $true; via = 'overlay'; x = $x; y = $y; visible = $true
        cursorMode = $script:cursorMode; cursorSize = $script:cursorSize; cursorHoldMs = $script:cursorHoldMs
        cursorTheme = [AciOverlay]::ActiveTheme; theme = [AciOverlay]::Scheme
        note = '只移动 AI 光标，没有移动主人的真实光标'
      }
    }
    'overlay' {
      if ($req.show -eq $false) {
        [AciOverlay]::Hide()
        return @{ ok = $true; visible = $false; cursorMode = $script:cursorMode; cursorState = $script:cursorStyle; cursorTheme = [AciOverlay]::ActiveTheme }
      }
      $x = if ($null -ne $req.x) { [int]$req.x } elseif ([AciOverlay]::HasLast) { [AciOverlay]::LastX } else { [AciInput]::CursorPos()[0] }
      $y = if ($null -ne $req.y) { [int]$req.y } elseif ([AciOverlay]::HasLast) { [AciOverlay]::LastY } else { [AciInput]::CursorPos()[1] }
      Show-StateAt 'pointer' $x $y
      return @{
        ok = $true; visible = $true; x = $x; y = $y
        cursorMode = $script:cursorMode; cursorSize = $script:cursorSize; cursorHoldMs = $script:cursorHoldMs
        cursorState = $script:cursorStyle; cursorTheme = [AciOverlay]::ActiveTheme; theme = [AciOverlay]::Scheme
      }
    }
    'pause' {
      [AciInput]::Pause('api')
      if ([AciOverlay]::HasLast) { [AciOverlay]::ShowAt([AciOverlay]::LastX, [AciOverlay]::LastY) }
      return Get-StatusResult
    }
    'resume' {
      [AciInput]::Resume()
      $script:cursorStyle = 'pointer'
      [AciOverlay]::SetStyle('pointer')
      if ([AciOverlay]::HasLast) { [AciOverlay]::ShowAt([AciOverlay]::LastX, [AciOverlay]::LastY) }
      return Get-StatusResult
    }
    'click' {
      $x = [int]$req.x
      $y = [int]$req.y
      $button = if ($req.button) { [string]$req.button } else { 'left' }
      $count = if ($req.count) { [int]$req.count } else { 1 }
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      [AciOverlay]::Hide()

      if ($mode -eq 'physical') {
        if (-not $script:allowPhysical) {
          return @{
            ok = $false; reason = 'physical-mouse-forbidden'; strictNoRealMouse = $true
            note = '默认禁止 physical（真实鼠标会动主人的光标）。要真实点击，请先把 allowPhysical 打开'
          }
        }
        try {
          [AciInput]::PhysicalClick($x, $y, ($button -ne 'left'), $count)
        } catch {
          return @{ ok = $false; reason = ($_.Exception.Message) }
        }
        Show-StateAt 'cross' $x $y
        return @{ ok = $true; via = 'physical'; x = $x; y = $y; note = 'physical：真实光标被移动到目标位置并点击（你显式允许了 physical）' }
      }

      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoRealMouse = $true
          note = '必须提供目标窗口 hwnd（先用 windows 拿 hwnd）；只按坐标点会点到主人正在用的窗口'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [AciInput]::IsWindow($target)) {
        return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd }
      }
      $root = [AciInput]::RootOf($target)
      $h = [AciInput]::ChildAt($root, $x, $y)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      $cls0 = [AciInput]::WindowClass($h)
      if ($button -eq 'left' -and $count -eq 1 -and $cls0 -match 'BUTTON|Button') {
        # BM_CLICK 直接让按钮发命令，不经过鼠标消息，也不抢焦点。
        [AciInput]::PostMessage($h, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Show-StateAt 'link' $x $y
        return @{ ok = $true; via = 'bm_click'; hwnd = [long]$h; target = [long]$root; verified = $false; note = '按钮 BM_CLICK；不移动鼠标、不抢焦点' }
      }
      $r = Invoke-UiaClickInWindow $root $x $y
      if ($r.ok) {
        $state = if ($r.pattern -and ([string]$r.type -match 'Edit|Document|Text')) { 'text' } elseif ($r.pattern) { 'link' } else { 'pointer' }
        Show-StateAt $state $x $y
        $r['x'] = $x
        $r['y'] = $y
        $r['hwnd'] = [long]$root
        $r['button'] = $button
        $r['count'] = $count
        return $r
      }
      $h = [AciInput]::ChildAt($root, $x, $y)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      [AciInput]::PostMouseClick($h, $x, $y, ($button -eq 'right'), $count)
      $cls = [AciInput]::WindowClass($h)
      $state2 = 'pointer'
      if ($cls -match 'BUTTON|Button|SysLink|Toolbar|Menu') { $state2 = 'link' }
      elseif ($cls -match 'EDIT|Edit|TextBox') { $state2 = 'text' }
      Show-StateAt $state2 $x $y
      return @{
        ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root
        className = $cls; verified = $false
        note = '已投递给指定窗口；不移动真实鼠标，也不经过别的窗口'
      }

    }
    'type' {
      $text = [string]$req.text
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $replace = $false
      if ($null -ne $req.replace) { $replace = [bool]$req.replace }
      $hasPoint = ($null -ne $req.x -and $null -ne $req.y)
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      [AciOverlay]::Hide()

      if ($mode -eq 'physical') {
        if (-not $script:allowPhysical) {
          return @{
            ok = $false; reason = 'physical-keyboard-forbidden'; strictNoFocusSteal = $true
            note = '默认禁止 physical 键盘（会抢输入焦点）。要真实打字，请先把 allowPhysical 打开'
          }
        }
        try {
          [AciInput]::PhysicalText($text)
        } catch {
          return @{ ok = $false; reason = ($_.Exception.Message) }
        }
        if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) }
        return @{ ok = $true; via = 'physical'; text = $text; note = 'physical：真实键盘输入到当前焦点窗口' }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoFocusSteal = $true
          note = '必须提供目标窗口 hwnd；不会把文字打进主人当前聚焦的输入框'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [AciInput]::IsWindow($target)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root = [AciInput]::RootOf($target)
      $h = $root
      if ($hasPoint) {
        $child = [AciInput]::ChildAt($root, [int]$req.x, [int]$req.y)
        if ($child -ne [IntPtr]::Zero) { $h = $child }
      }

      $cls = [AciInput]::WindowClass($h)
      if ($cls -match 'EDIT|Edit|TextBox') {
        $cur = [AciInput]::GetControlText($h)
        $want = if ($replace) { $text } else { $cur + $text }
        [AciInput]::SetTextMessage($h, $want) | Out-Null
        Start-Sleep -Milliseconds 60
        $now = [AciInput]::GetControlText($h)
        if ($now -eq $want) {
          if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) }
          return @{ ok = $true; via = 'wm_settext'; hwnd = [long]$h; target = [long]$root; verified = $true; text = $want; note = '直接写入目标 Edit 控件（已回读确认），未抢焦点、未移动鼠标' }
        }
      }

      $r = Set-UiaTextInWindow $h $text $replace
      if ($r.ok) {
        if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) }
        $r['hwnd'] = [long]$h
        $r['target'] = [long]$root
        return $r
      }

      [AciInput]::PostText($h, $text)
      if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) }
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root; verified = $false; note = '已向目标窗口投递文字；不抢焦点' }
    }
    'key' {
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      $raw = [string]$req.keys
      if ([string]::IsNullOrWhiteSpace($raw)) { return @{ ok = $false; reason = 'keys required' } }
      $names = $raw -split '\+'
      $vks = @()
      foreach ($n in $names) { $vks += (Get-Vk $n) }

      if ($mode -eq 'physical') {
        if (-not $script:allowPhysical) {
          return @{
            ok = $false; reason = 'physical-keyboard-forbidden'; strictNoFocusSteal = $true
            note = '默认禁止 physical 键盘（会抢输入焦点）。要真实按键，请先把 allowPhysical 打开'
          }
        }
        try {
          [AciInput]::PhysicalKeySequence([ushort[]]$vks)
        } catch {
          return @{ ok = $false; reason = ($_.Exception.Message) }
        }
        $script:cursorStyle = 'text'
        [AciOverlay]::SetStyle('text')
        return @{ ok = $true; via = 'physical'; keys = $raw; note = 'physical：真实按键发到当前焦点窗口' }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoFocusSteal = $true
          note = '必须提供目标窗口 hwnd；不会把按键打到主人当前聚焦的窗口'
        }
      }
      $h = [IntPtr]$targetHwnd
      if (-not [AciInput]::IsWindow($h)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      foreach ($vk in $vks) { [AciInput]::PostKey($h, [int]$vk, $true, $false, $false) }
      [Array]::Reverse($vks)
      foreach ($vk in $vks) { [AciInput]::PostKey($h, [int]$vk, $false, $false, $false) }
      $script:cursorStyle = 'text'
      [AciOverlay]::SetStyle('text')
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; keys = $raw; verified = $false; note = '已向指定窗口投递按键；不抢焦点' }
    }
    'scroll' {
      $x = [int]$req.x
      $y = [int]$req.y
      $delta = if ($req.delta) { [int]$req.delta } else { -120 }
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      [AciOverlay]::Hide()

      if ($mode -eq 'physical') {
        if (-not $script:allowPhysical) {
          return @{
            ok = $false; reason = 'physical-mouse-forbidden'; strictNoRealMouse = $true
            note = '默认禁止 physical（真实鼠标会动主人的光标）。要真实滚轮，请先把 allowPhysical 打开'
          }
        }
        try {
          [AciInput]::PhysicalScroll($x, $y, $delta)
        } catch {
          return @{ ok = $false; reason = ($_.Exception.Message) }
        }
        Show-StateAt 'vert' $x $y
        return @{ ok = $true; via = 'physical'; delta = $delta; note = 'physical：真实滚轮（你显式允许了 physical）' }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoRealMouse = $true
          note = '必须提供目标窗口 hwnd；只按坐标滚动会滚到主人正在用的窗口'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [AciInput]::IsWindow($target)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root = [AciInput]::RootOf($target)
      $h = [AciInput]::ChildAt($root, $x, $y)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      [AciInput]::PostMouseScroll($h, $x, $y, $delta)
      Show-StateAt 'vert' $x $y
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root; delta = $delta; verified = $false; note = '已投递给指定窗口；不移动真实鼠标' }
    }
    'drag' {
      $x1 = [int]$req.x
      $y1 = [int]$req.y
      $x2 = [int]$req.toX
      $y2 = [int]$req.toY
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $duration = if ($req.durationMs) { [int]$req.durationMs } else { 400 }
      $dx = $x2 - $x1
      $dy = $y2 - $y1
      $dragState = if ([Math]::Abs($dx) -gt [Math]::Abs($dy) * 1.6) { 'horz' }
                   elseif ([Math]::Abs($dy) -gt [Math]::Abs($dx) * 1.6) { 'vert' }
                   elseif ($dx * $dy -gt 0) { 'dgn1' }
                   elseif ($dx * $dy -lt 0) { 'dgn2' }
                   else { 'move' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      [AciOverlay]::Hide()

      if ($mode -eq 'physical') {
        if (-not $script:allowPhysical) {
          return @{
            ok = $false; reason = 'physical-mouse-forbidden'; strictNoRealMouse = $true
            note = '默认禁止 physical（真实鼠标会动主人的光标）。要真实拖拽，请先把 allowPhysical 打开'
          }
        }
        try {
          [AciInput]::PhysicalDrag($x1, $y1, $x2, $y2, $duration)
        } catch {
          return @{ ok = $false; reason = ($_.Exception.Message) }
        }
        Show-StateAt $dragState $x2 $y2
        return @{ ok = $true; via = 'physical'; note = 'physical：真实拖拽（你显式允许了 physical）' }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoRealMouse = $true
          note = '必须提供目标窗口 hwnd；只按坐标拖拽会拖到主人正在用的窗口'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [AciInput]::IsWindow($target)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root = [AciInput]::RootOf($target)
      $h = [AciInput]::ChildAt($root, $x1, $y1)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      [AciInput]::PostMouseDrag($h, $x1, $y1, $x2, $y2, [Math]::Max(8, [int]($duration / 20)))
      Show-StateAt $dragState $x2 $y2
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root; verified = $false; note = '已投递给指定窗口；不移动真实鼠标' }
    }
    'capture' {
      $path = [string]$req.path
      if ([string]::IsNullOrWhiteSpace($path)) { throw 'path required' }
      $wasVisible = [AciOverlay]::VisibleNow()
      if ($wasVisible) { [AciOverlay]::Hide() }
      try {
        $dir = [System.IO.Path]::GetDirectoryName($path)
        if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
        if ($req.rect) {
          $parts = ([string]$req.rect) -split ','
          $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
          [AciInput]::CapturePng($path, $x, $y, $w, $h) | Out-Null
        } else {
          [AciInput]::CapturePng($path, 0, 0, 0, 0) | Out-Null
        }
      } finally {
        if ($wasVisible -and [AciOverlay]::HasLast) {
          [AciOverlay]::ShowAt([AciOverlay]::LastX, [AciOverlay]::LastY)
        }
      }
      return @{ ok = $true; path = $path }
    }
    'overlayShot' {
      $path = [string]$req.path
      if ([string]::IsNullOrWhiteSpace($path)) { throw 'path required' }
      $dir = [System.IO.Path]::GetDirectoryName($path)
      if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
      $s = 0
      if ($null -ne $req.size) { $s = [int]$req.size }
      if ($s -le 0) { $s = $script:cursorSize }
      [AciInput]::CapturePng($path, [AciOverlay]::LastX, [AciOverlay]::LastY, $s, $s) | Out-Null
      return @{ ok = $true; path = $path; x = [AciOverlay]::LastX; y = [AciOverlay]::LastY; size = $s }
    }
    'shutdown' {
      [AciOverlay]::Stop()
      [AciInput]::StopHooks()
      [AciInput]::StopHotkey()
      return @{ ok = $true }
    }
    default { throw "unknown command: $cmd" }
  }
}

# ---------------------------------------------------------------- 素材载入

# 读 assets/cursors/manifest.json，把每个主题的状态表摊平成
# 「state|png|frames|cols|cell|delay|hotx|hoty」交给 C#（C# 不引 JSON 解析器）。
function Import-CursorAssets {
  $loaded = @{}
  $manifestPath = Join-Path $script:assetsRoot 'manifest.json'
  if (-not (Test-Path $manifestPath)) {
    [Console]::Error.WriteLine("找不到光标 manifest：$manifestPath（先跑 aci build-cursors）")
    return $loaded
  }
  $manifest = $null
  try {
    $manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
  } catch {
    [Console]::Error.WriteLine("manifest 解析失败：$($_.Exception.Message)")
    return $loaded
  }
  foreach ($theme in @('light', 'dark')) {
    $node = $manifest.themes.$theme
    if ($null -eq $node -or $null -eq $node.states) { continue }
    $dir = Join-Path $script:assetsRoot $theme
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($prop in $node.states.PSObject.Properties) {
      $st = $prop.Value
      $path = Join-Path $dir ([string]$st.file)
      if (-not (Test-Path $path)) { continue }
      $lines.Add(('{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f $prop.Name, $path, $st.frames, $st.cols, $st.cell, $st.frameDelayMs, $st.hotspot.x, $st.hotspot.y))
    }
    $sep = [string][char]10
    $count = [AciOverlay]::LoadThemeSet($theme, ($lines -join $sep))
    $loaded[$theme] = $count
  }
  return $loaded
}

# ---------------------------------------------------------------- main

$loadedThemes = Import-CursorAssets
if ($loadedThemes.Count -eq 0) {
  [Console]::Error.WriteLine('没有可用的光标素材；覆盖层会退化成占位圆环')
}

try {
  [AciOverlay]::Configure($script:assetsRoot, $script:cursorTheme, $script:cursorSize, $script:cursorOpacity, $script:animations)
  [AciOverlay]::SetStyle($script:cursorStyle)
  [AciOverlay]::SetMode($script:cursorMode, $script:cursorHoldMs)
} catch {
  [Console]::Error.WriteLine("overlay 初始化失败：$($_.Exception.Message)")
}

[AciInput]::AllowPhysical = $script:allowPhysical
try { Set-HotkeyFromSpec $script:hotkey | Out-Null } catch { [Console]::Error.WriteLine("热键注册失败：$($_.Exception.Message)") }

$ready = @{
  event = 'ready'
  v = 2
  pid = $PID
  version = $script:sidecarVersion
  powershell = $PSVersionTable.PSVersion.ToString()
  uia = $script:uia
  hotkey = [AciInput]::HotkeySpec
  hotkeyRegistered = [AciInput]::HotkeyRegistered
  theme = [AciOverlay]::Scheme
  cursorTheme = [AciOverlay]::CursorThemeSetting
  activeCursorTheme = [AciOverlay]::ActiveTheme
  cursorStates = $script:styleNames
  physical = $script:allowPhysical
  assets = $script:assetsRoot
  themes = $loadedThemes
}
[Console]::Out.WriteLine((ConvertTo-Json $ready -Compress -Depth 8))
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = $null
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $script:requestCursorState = if ($req.cursorState) { ([string]$req.cursorState).ToLower() } else { $null }
    $result = Invoke-Request $req
    if ($result -is [hashtable]) {
      $result['cursorState'] = if ([AciInput]::Paused) { 'unavailiable' } else { $script:cursorStyle }
      $result['cursorTheme'] = [AciOverlay]::ActiveTheme
    }
    $resp = @{ id = $id; ok = $true; result = $result }
  } catch {
    $resp = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json $resp -Compress -Depth 16))
  [Console]::Out.Flush()
  if ($null -ne $req -and $req.cmd -eq 'shutdown') { break }
}
