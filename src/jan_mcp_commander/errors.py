"""Safe actionable public errors: never reflect commands, paths, tokens or exception traces."""
from functools import wraps
from datetime import datetime, timezone
import inspect
import json
import os
import re
import uuid
from .core import PermissionDenied

_SENSITIVE = re.compile(r'pass(?:word)?|token|secret|api[_-]?key|authorization|bearer|otp|cookie|credential', re.I)
_CONTENT = {'content','file_content','screenshot','image','image_base64','data','bytes'}

def _preview(value, key='', depth=0):
    """Bounded local terminal preview; no claim of universal secret detection."""
    if _SENSITIVE.search(key) or key.casefold() in _CONTENT:
        return '[redacted]'
    if depth > 3:
        return '[nested data omitted]'
    if isinstance(value, dict):
        return {str(k)[:64]:_preview(v,str(k),depth+1) for k,v in list(value.items())[:24]}
    if isinstance(value,(list,tuple)):
        return [_preview(v,key,depth+1) for v in value[:12]]
    if isinstance(value,str):
        if _SENSITIVE.search(value):return '[redacted: possible secret]'
        return value[:512]+('[truncated]' if len(value)>512 else '')
    if type(value) in (int,float,bool) or value is None:return value
    return '[non-text data omitted]'

def _detail_event(tool, phase, call_id, data):
    if os.environ.get('JAN_REMOTE_LIVE_DETAILS')!='1':return
    try:
        payload={'tool':tool,'phase':phase,'call_id':call_id,'data':_preview(data)}
        line=json.dumps(payload,ensure_ascii=True)
        if len(line)>7000:
            payload['data']={'notice':'Preview too large; arguments/results omitted'}
        print('JAN_EVENT '+json.dumps(payload,ensure_ascii=True),flush=True)
    except (OSError, ValueError, TypeError):
        pass  # Terminal display must not change the result of a tool call.

def public_error(exc):
    from .windows_uia import UIAutomationError
    if isinstance(exc, UIAutomationError):
        return {'error_code':exc.code,'error':str(exc)}
    from .applications import ApplicationError
    if isinstance(exc, ApplicationError):
        return {'error_code':exc.code,'error':str(exc)}
    from .coordination import CoordinationError
    from .privacy import RULES
    if isinstance(exc, CoordinationError):
        return {'error_code': exc.code, 'error': str(exc)}
    causes = []
    current = exc
    while current is not None and len(causes) < 8 and current not in causes:
        causes.append(current)
        current = current.__cause__
    for cause in reversed(causes):
        value = str(cause).casefold()
        # Match fixed local categories only; never return exception text or paths.
        if value == RULES['error'].casefold():
            return {'error_code':'SENSITIVE_CONTENT_BLOCKED','error':'Sensitive personal or authentication data was blocked. No private content is returned; inspect the action state before retrying a write.'}
        if value == 'media verification timed out; no output saved':
            return {'error_code':'MEDIA_VERIFICATION_TIMEOUT','error':'Media integrity verification exceeded its processing budget. No media output was saved. Wait for active work to finish before another read; inspect action receipts before repeating a write.'}
        if value == 'media processing timed out; no output saved':
            return {'error_code':'MEDIA_PROCESSING_TIMEOUT','error':'Media processing exceeded its time budget. No output was saved. Wait for active work to finish before retrying a read; inspect receipts before repeating a write.'}
        if value in {'file changed; read it again before editing', 'file changed before apply', 'file changed; read it again before modifying'}:
            return {'error_code':'HASH_MISMATCH','error':'File changed since inspection. Read and inspect it again, then preview the edit before requesting approval.'}
        if isinstance(cause, FileNotFoundError):
            writing = any(str(item).casefold() == 'write denied' for item in causes)
            return {'error_code':'PARENT_DIRECTORY_NOT_FOUND' if writing else 'FILE_NOT_FOUND',
                    'error':'Parent directory does not exist. Choose an existing approved directory before creating the file.' if writing else 'File or directory not found in the approved workspace. List its parent and check the relative path.'}
        if isinstance(cause, FileExistsError):
            return {'error_code':'ALREADY_EXISTS','error':'The target already exists. Choose a new name or review an explicit overwrite.'}
        if isinstance(cause, NotADirectoryError) or value == 'directory required' or getattr(cause,'winerror',None) == 267:
            return {'error_code':'NOT_A_DIRECTORY','error':'This operation requires a directory. Inspect the target and choose a folder.'}
        if isinstance(cause, PermissionError):
            return {'error_code':'PERMISSION_DENIED','error':'The operating system denied access. Check local account permissions; do not bypass workspace restrictions.'}
        if value in {'unsafe path','invalid relative path','file path required'}:
            return {'error_code':'INVALID_PATH','error':'Use a path relative to the approved workspace. Absolute paths, parent traversal and invalid filename characters are not allowed.'}
        if value in {'sensitive path denied','links and reparse points denied','reparse point denied','single-link regular file required'}:
            return {'error_code':'PATH_POLICY_DENIED','error':'This path is blocked by workspace policy. Choose an ordinary non-sensitive file or directory inside the approved workspace.'}
    code='INVALID_ARGUMENT';message='Check the documented input schema and selected workflow.'
    if isinstance(exc, PermissionDenied):
        value=str(exc).casefold()
        if value=='request limit reached; retry after one minute':code='RATE_LIMITED';message='Local request limit reached. Wait up to 60 seconds before retrying a read. Inspect action receipts before resubmitting a write.'
        elif 'session limit' in value:code='SESSION_CAPACITY';message='Running session limit reached; stop an active PCRC session.'
        elif 'disabled' in value or 'expired' in value:code='CAPABILITY_DISABLED';message='Capability disabled or expired; enable it locally.'
        elif 'desktop text input incomplete' in value:code='DESKTOP_INPUT_UNCERTAIN';message='Text input was incomplete. Inspect actual text before continuing; do not replay automatically.'
        elif 'frame' in value or 'foreground' in value:code='DESKTOP_FRAME_REQUIRED';message='Capture a fresh desktop screenshot, verify the foreground application, then use its frame_id once.'
        elif value in {'invalid key combination','use one to four named keys'}:code='DESKTOP_KEYS_INVALID';message='Use one to four supported key names, for example keys=["ctrl","l"], with a fresh frame_id. No key was delivered.'
        elif 'unknown session' in value or value == 'unknown owned command':code='UNKNOWN_SESSION';message='Session unknown or no longer retained. Use the ID returned by start_process or start_program; synchronous run_command sessions are closed after returning output.'
        elif value == 'owned command is not accepting input':code='PROCESS_INPUT_UNAVAILABLE';message='This session is not accepting input. Inspect a running session created by start_process or start_program; do not send input to a completed run_command session.'
        elif 'credentials locally' in value:code='MANUAL_CREDENTIAL_ENTRY';message='Enter credentials locally in the isolated browser.'
        elif 'audit' in value:code='AUDIT_UNAVAILABLE';message='Private audit storage unavailable; inspect local state before retrying.'
        else:code='OPERATION_DENIED';message='Operation denied by local capability, workspace or input policy; check permissions and relative paths.'
    elif exc.__class__.__module__.startswith('playwright'):
        code='BROWSER_UNAVAILABLE';message='Selected browser could not start or complete the action; check local browser installation, runtime paths and selector, then retry a safe read.'
    elif isinstance(exc,OSError):code='RESOURCE_UNAVAILABLE';message='Required local file, executable or OS resource is unavailable.'
    elif not isinstance(exc,(ValueError,TypeError,KeyError)):
        code='TOOL_FAILURE';message='PCRC could not complete the operation; verify its outcome before retrying a mutation.'
    return {'error_code':code,'error':message}

def tool_errors(commander):
    def decorate(fn):
        @wraps(fn)
        def guarded(*args,**kwargs):
            commander._last_mcp_tool_call_utc=datetime.now(timezone.utc).isoformat()
            call_id=uuid.uuid4().hex
            if os.environ.get('JAN_REMOTE_LIVE_DETAILS')=='1':
                try:
                    arguments=inspect.signature(fn).bind_partial(*args,**kwargs).arguments
                    _detail_event(fn.__name__,'received',call_id,{'arguments':dict(arguments),'metadata':{'transport':'http','client_info':'not forwarded by gateway'}})
                except (TypeError, ValueError):
                    _detail_event(fn.__name__,'received',call_id,{'arguments':'unavailable'})
            def event(status):
                if os.environ.get('JAN_REMOTE_LIVE_EVENTS') == '1' and os.environ.get('JAN_REMOTE_LIVE_DETAILS') != '1':
                    # Fixed tool name and outcome only. Never echo arguments,
                    # file content, command text, output, paths or errors.
                    try:print('JAN_EVENT '+json.dumps({'tool':fn.__name__,'status':status}),flush=True)
                    except (OSError, ValueError, TypeError):pass
            try:
                result=fn(*args,**kwargs)
                event('completed')
                _detail_event(fn.__name__,'completed',call_id,{'result':result})
                return result
            except Exception as exc:
                from mcp.types import CallToolResult,TextContent
                result=public_error(exc)
                event('denied' if isinstance(exc,PermissionDenied) else 'failed')
                _detail_event(fn.__name__,'denied' if isinstance(exc,PermissionDenied) else 'failed',call_id,{'error_code':result['error_code']})
                return CallToolResult(isError=True,content=[TextContent(type='text',text=json.dumps(result))],structuredContent=result)
        return guarded
    return decorate
