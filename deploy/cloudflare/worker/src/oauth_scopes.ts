export const PUBLIC_SCOPES=['pcrc:read','pcrc:control'];
// Existing grants keep working; legacy aliases are accepted but never advertised.
export const SUPPORTED_SCOPES=[...PUBLIC_SCOPES,'jan:read','jan:control'];
export const hasReadScope=(scopes?:string[])=>scopes?.some(scope=>scope==='pcrc:read'||scope==='jan:read')===true;
export const hasControlScope=(scopes?:string[])=>scopes?.some(scope=>scope==='pcrc:control'||scope==='jan:control')===true;
export const displayScopes=(scopes:string[])=>[...new Set(scopes.map(scope=>scope==='jan:read'?'pcrc:read':scope==='jan:control'?'pcrc:control':scope))];
