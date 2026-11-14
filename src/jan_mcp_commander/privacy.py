"""Shared high-confidence text minimization. This is not a complete data-loss prevention system."""
import ast
import json
from pathlib import Path
import re

RULES=json.loads(Path(__file__).with_name('privacy-rules.json').read_text(encoding='utf-8'))
PATTERNS=[re.compile(item['pattern'],re.I if 'i' in item['flags'] else 0) for item in RULES['patterns']]
LABEL=re.compile(RULES['labeled_secret']['pattern'],re.I)
CARDS=re.compile(RULES['card_pattern'])


def luhn(number):
    digits=[int(char) for char in number if char.isdigit() and char.isascii()]
    if len(digits) not in RULES['card_lengths']:
        return False
    return sum((value*2-9 if value>4 else value*2) if index%2==len(digits)%2 else value
               for index,value in enumerate(digits))%10==0


def _plain_sensitive(data):
    if any(pattern.search(data) for pattern in PATTERNS):return True
    for match in LABEL.finditer(data):
        value=match.group(1)
        quoted=match.start(1)>0 and data[match.start(1)-1] in {'"', "'"}
        call=not quoted and re.fullmatch(RULES['labeled_secret']['unquoted_call_pattern'],value)
        if (quoted or value.casefold() not in RULES['labeled_secret']['ignore_values']) and not call:
            return True
    return any(luhn(match.group(1)) for match in CARDS.finditer(data))


class _JsonObject(list):
    """Preserve duplicate JSON keys so a later null cannot conceal a private value."""


_NOT_LITERAL=object()


def _literal_repr(data,depth):
    try:root=ast.parse(data,mode='eval').body
    except (SyntaxError,ValueError):return _NOT_LITERAL
    allowed=(ast.Dict,ast.List,ast.Tuple,ast.Constant,ast.UnaryOp,ast.UAdd,ast.USub,ast.Load)
    pending=[(root,0)];count=0
    while pending:
        node,level=pending.pop();count+=1
        if count>4096 or level+depth>12:raise OverflowError('Literal inspection limit')
        if not isinstance(node,allowed):return _NOT_LITERAL
        if isinstance(node,ast.Dict) and any(key is None for key in node.keys):return _NOT_LITERAL
        if isinstance(node,ast.Constant) and type(node.value) not in {str,int,float,bool,bytes,type(None)}:return _NOT_LITERAL
        pending.extend((child,level+1) for child in ast.iter_child_nodes(node))
    def value(node):
        if isinstance(node,ast.Dict):return _JsonObject((str(ast.literal_eval(key)),value(child)) for key,child in zip(node.keys,node.values))
        if isinstance(node,(ast.List,ast.Tuple)):return [value(child) for child in node.elts]
        item=ast.literal_eval(node)
        return item.decode('utf-8',errors='ignore') if isinstance(item,bytes) else item
    try:return value(root)
    except (ValueError,TypeError):return _NOT_LITERAL


def _sensitive_text(data,depth):
    if _plain_sensitive(data):return True
    if data.lstrip().startswith(('{','[','(',"'",'"')):
        if depth>12 or len(data.encode('utf-8'))>262144:return True
        try:value=json.loads(data,object_pairs_hook=_JsonObject)
        except ValueError:
            try:value=_literal_repr(data,depth)
            except (OverflowError,RecursionError,MemoryError):return True
            if value is _NOT_LITERAL:return False
        except (RecursionError,MemoryError):return True
        count=[0]
        def walk(item,label='',level=0):
            count[0]+=1
            if count[0]>4096 or level+depth>12:return True
            if isinstance(item,_JsonObject):
                for key,child in item:
                    if _plain_sensitive(key):return True
                    if key=='type' and isinstance(child,str) and child in RULES['labeled_secret']['ignore_values']:continue
                    if walk(child,key if sensitive_label(key) else label,level+1):return True
                return False
            if isinstance(item,list):return any(walk(child,label,level+1) for child in item)
            if item is None:return False
            if label and _plain_sensitive(label+'='+json.dumps(item)):return True
            return isinstance(item,str) and _sensitive_text(item,depth+level+1)
        return walk(value)
    return False


def sensitive_text(data):
    if isinstance(data,bytes):data=data.decode('utf-8',errors='ignore')
    return isinstance(data,str) and _sensitive_text(data,0)


def assert_public_text(text):
    if sensitive_text(text):raise ValueError(RULES['error'])
    return text


def sensitive_label(text):
    return isinstance(text,str) and any(_plain_sensitive(text+'='+probe) for probe in RULES['label_probe_values'])
