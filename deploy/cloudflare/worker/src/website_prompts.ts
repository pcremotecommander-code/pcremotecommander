import {escaped} from './policy.ts';
import {portalPage,pageHeading,hidden,type PortalOwner} from './portal_ui.ts';

export type WebsitePrompt={id:string;title:string;description:string;category:string;prompt:string;published:boolean;deleted?:boolean};
export function validWebsitePrompt(value:unknown):value is WebsitePrompt {
  if(!value||typeof value!=='object')return false;
  const p=value as WebsitePrompt;
  return typeof p.id==='string'&&/^[a-f0-9-]{36}$/.test(p.id)&&
    ['title','description','prompt'].every(key=>{
      const text=p[key as 'title'|'description'|'prompt'];
      return typeof text==='string'&&text.trim().length>0&&text.length<=({title:90,description:240,prompt:3000}[key]??0)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
    })&&typeof p.category==='string'&&/^[a-z0-9-]{1,40}$/.test(p.category)&&typeof p.published==='boolean';
}

export type PromptCategory={id:string;name:string};
const defaultCategories:PromptCategory[]=[{id:'explore',name:'Explore'},{id:'edit',name:'Edit'},{id:'diagnose',name:'Diagnose'}];
export async function websitePromptStore(storage:DurableObjectStorage,path:string,body:Record<string,unknown>,accountId:string,ownerId:string):Promise<Response> {
  if(accountId!==ownerId)return Response.json({error:'Owner required'},{status:403});
  if(path==='/website-prompts/list')return Response.json(await storage.get<WebsitePrompt[]>('website:prompts:v1')??[]);
  if(path==='/website-prompts/categories')return Response.json(await storage.get<PromptCategory[]>('website:categories:v1')??defaultCategories);
  const action=path.split('/').at(-1);
  if(!['save','category-add','visibility','delete','restore'].includes(action??''))return Response.json({error:'Not found'},{status:404});
  if(action==='save'&&!validWebsitePrompt(body))return Response.json({error:'Invalid prompt fields'},{status:400});
  if(action==='category-add'&&(typeof body.id!=='string'||!/^[a-f0-9-]{36}$/.test(body.id)||typeof body.name!=='string'||!body.name.trim()||body.name.length>40||/[\x00-\x1f]/.test(body.name)))return Response.json({error:'Invalid category'},{status:400});
  if(!['save','category-add'].includes(action!)&&(typeof body.id!=='string'||!/^[a-f0-9-]{36}$/.test(body.id)))return Response.json({error:'Invalid prompt ID'},{status:400});
  if(action==='visibility'&&typeof body.published!=='boolean')return Response.json({error:'Invalid visibility'},{status:400});
  return storage.transaction(async tx=>{
    const categories=await tx.get<PromptCategory[]>('website:categories:v1')??defaultCategories;
    if(action==='category-add') {
      if(categories.some(c=>c.id===body.id))return Response.json({ok:true});
      if(categories.length>=30||categories.some(c=>c.name.toLowerCase()===(body.name as string).trim().toLowerCase()))return Response.json({error:'Category already exists or category limit reached'},{status:409});
      await tx.put('website:categories:v1',[...categories,{id:body.id as string,name:(body.name as string).trim()}]);
      return Response.json({ok:true});
    }
    const items=await tx.get<WebsitePrompt[]>('website:prompts:v1')??[];
    if(action==='save') {
      const item=body as WebsitePrompt;
      if(!categories.some(c=>c.id===item.category))return Response.json({error:'Choose an existing category'},{status:400});
      const existing=items.findIndex(p=>p.id===item.id);
      if(existing<0&&items.length>=50)return Response.json({error:'The library supports 50 owner prompts including deleted entries'},{status:409});
      const saved={id:item.id,title:item.title.trim(),description:item.description.trim(),category:item.category,prompt:item.prompt.trim(),published:item.published,deleted:false};
      if(existing<0)items.unshift(saved);else items[existing]=saved;
    } else {
      const item=items.find(p=>p.id===body.id);
      if(!item)return Response.json({error:'Prompt unavailable'},{status:404});
      if(action==='delete'){item.deleted=true;item.published=false;}
      else if(action==='restore'){item.deleted=false;item.published=false;}
      else {if(item.deleted)return Response.json({error:'Restore this prompt first'},{status:409});item.published=body.published as boolean;}
    }
    await tx.put('website:prompts:v1',items);
    return Response.json({ok:true});
  });
}

export function websitePromptManager(owner:PortalOwner,items:WebsitePrompt[],categories:PromptCategory[],notice=false,editId:string|null=null) {
  const edit=items.find(p=>p.id===editId&&!p.deleted);
  const rows=items.map(p=>'<article class="panel"><div class="panel-body"><h2>'+escaped(p.title)+'</h2><p>'+escaped(p.description)+'</p><p class="footnote">'+escaped(categories.find(c=>c.id===p.category)?.name??p.category)+' · '+(p.deleted?'Deleted — recoverable':p.published?'Published':'Hidden')+'</p><div class="action-row">'+(!p.deleted?'<a class="button neutral" href="/admin/prompts?edit='+escaped(p.id)+'">Edit prompt</a>':'')+'<form method="post" action="/admin/prompts">'+hidden('csrf',owner.csrf)+hidden('id',p.id)+(p.deleted?'<button class="button neutral" name="action" value="restore">Restore as hidden</button>':hidden('published',p.published?'no':'yes')+'<button class="button neutral" name="action" value="visibility">'+(p.published?'Hide':'Publish')+'</button> <button class="button danger" name="action" value="delete">Delete</button>')+'</form></div></div></article>').join('');
  const categoryForm='<section class="panel"><div class="panel-body"><h2>Categories</h2><p>'+categories.map(c=>escaped(c.name)).join(' · ')+'</p><form method="post" action="/admin/prompts">'+hidden('csrf',owner.csrf)+hidden('action','category-add')+hidden('id',crypto.randomUUID())+'<div class="field"><label for="category-name">New category name</label><input id="category-name" name="name" maxlength="40" required></div><button class="button neutral" type="submit">Create category</button></form></div></section>';
  const form='<section class="panel" id="editor"><div class="panel-body"><h2>'+(edit?'Edit prompt':'Create a website prompt')+'</h2><p class="subtitle">Published fields are public. Use original text without secrets or personal data.</p><form method="post" action="/admin/prompts">'+hidden('csrf',owner.csrf)+hidden('action','save')+hidden('id',edit?.id??crypto.randomUUID())+'<div class="field"><label for="prompt-title">Title</label><input id="prompt-title" name="title" value="'+escaped(edit?.title??'')+'" maxlength="90" required></div><div class="field"><label for="prompt-description">Short description</label><input id="prompt-description" name="description" value="'+escaped(edit?.description??'')+'" maxlength="240" required></div><div class="field"><label for="prompt-category">Category</label><select id="prompt-category" name="category">'+categories.map(c=>'<option value="'+escaped(c.id)+'"'+(edit?.category===c.id?' selected':'')+'>'+escaped(c.name)+'</option>').join('')+'</select></div><div class="field"><label for="prompt-text">Prompt text</label><textarea id="prompt-text" name="prompt" rows="7" maxlength="3000" required style="width:100%;padding:14px;border:1px solid #a9c2bc;border-radius:8px;font:14px/1.7 system-ui">'+escaped(edit?.prompt??'')+'</textarea></div><div class="field"><label><input type="checkbox" name="published" value="yes"'+(!edit||edit.published?' checked':'')+'> Published on the public website</label></div><div class="action-row"><button class="button primary" type="submit">'+(edit?'Save changes':'Publish prompt')+'</button>'+(edit?'<a class="button neutral" href="/admin/prompts">Cancel editing</a>':'')+'</div></form></div></section>';
  return portalPage(pageHeading('Website prompts','Create categories and manage prompts in your public library.')+(notice?'<div class="notice" role="status">Library updated. Public changes can take up to 30 seconds to appear after refresh.</div>':'')+categoryForm+form+rows,'Website prompts',{owner,ownerSite:true,active:'prompts'});
}
