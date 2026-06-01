"""
YancoRead — Single Instance Enforcement
Windows named mutex so a second launch forwards its file to the running window
instead of opening a duplicate. Auto-released by Windows on exit (even on crash).
Non-Windows platforms skip enforcement (return first-instance = True).
"""

import ctypes
import sys
from ctypes import wintypes

_MUTEX_NAME = 'YancoRead_SingleInstance_Mutex'
_ERROR_ALREADY_EXISTS = 183
_mutex_handle = None

if sys.platform == 'win32':
    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    _kernel32.CreateMutexW.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _user32 = ctypes.WinDLL('user32', use_last_error=True)
    _user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
    _user32.MessageBoxW.restype = ctypes.c_int


def acquire_instance_lock() -> bool:
    """True if this is the first instance; False if one is already running."""
    global _mutex_handle
    if sys.platform != 'win32':
        return True
    _mutex_handle = _kernel32.CreateMutexW(None, False, _MUTEX_NAME)
    return ctypes.get_last_error() != _ERROR_ALREADY_EXISTS


def release_instance_lock() -> None:
    global _mutex_handle
    if _mutex_handle and sys.platform == 'win32':
        _kernel32.CloseHandle(_mutex_handle)
        _mutex_handle = None


def show_already_running_message() -> None:
    if sys.platform != 'win32':
        print('[YancoRead] Already running.')
        return
    _user32.MessageBoxW(None, 'YancoRead is already running.\n\nCheck your taskbar.',
                        'YancoRead', 0x00000040)
