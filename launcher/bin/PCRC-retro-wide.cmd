@echo off
setlocal
set "PCRC_ANIMATION=%~f0"
powershell.exe -NoLogo -NoProfile -Command "$s=[IO.File]::ReadAllText($env:PCRC_ANIMATION); & ([ScriptBlock]::Create($s.Substring($s.LastIndexOf('# START FILM')+12)))"
exit /b %errorlevel%
# START FILM
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Threading;
public class RetroPCRC {
 static bool In(double x,double y,int[] p){
  bool hit=false;
  for(int i=0,j=p.Length-2;i<p.Length;j=i,i+=2){
   double a=p[i],b=p[i+1],c=p[j],d=p[j+1];
   if((b>y)!=(d>y) && x<(c-a)*(y-b)/(d-b)+a)hit=!hit;
  }return hit;
 }
 static readonly int[] bowl={0,0,15,0,19,3,19,12,15,15,5,15,5,25,0,25}, hole={5,4,13,4,14,5,14,10,13,11,5,11}, leg={8,13,14,13,20,25,14,25}, cee={4,0,16,0,19,3,19,6,14,6,13,4,6,4,5,5,5,20,6,21,13,21,14,19,19,19,19,22,16,25,4,25,0,21,0,4};
 static bool Letter(int k,double x,double y){
  x-=(25-y)*.085;
  if(k==1||k==3)return In(x,y,cee);
  return (In(x,y,bowl)&&!In(x,y,hole))||(k==2&&In(x,y,leg));
 }
 static readonly int[,] pal={{236,253,255},{20,194,249},{58,151,251},{226,55,228},{252,115,136},{255,196,38}};
 public static void Play(int w,int rows){
  int[,] shape=new int[rows,w];
  for(int y=0;y<rows;y++)for(int x=0;x<w;x++){
   double u=(x+.5)*101/w-1.2,v=(y+.5)*29/rows-.8;
   for(int k=0;k<4;k++){double z=u-k*25;
    if(Letter(k,z,v)){shape[y,x]=(!Letter(k,z-.48,v)||!Letter(k,z,v-.75))?3:2;break;}
    if(Letter(k,z-.9,v-1.35)||Letter(k,z-.45,v-.67))shape[y,x]=1;
   }
  }
  string e="\u001b[";var clock=Stopwatch.StartNew();bool first=true;
  Console.Write(e+"?25l");
  try {while(true){
   double t=clock.Elapsed.TotalSeconds;var buf=new StringBuilder();if(!first)buf.Append(e+rows+"A");first=false;
   for(int y=0;y<rows;y++){int prev=-1;buf.Append('\r');
    for(int x=0;x<w;x++){
     int r=32,g=19,b=57,k=shape[y,x];double q=(x+.5)/w;
     if(k>0 && q<t/1.4){
      if(k==1){r=110;g=48;b=141;}else if(k==3){r=224;g=245;b=255;}else{
       double v=Math.Min(4.999,Math.Max(0,((y+.5)*29/rows-.8)*.2));int i=(int)v;double f=v-i;
       r=(int)(pal[i,0]*(1-f)+pal[i+1,0]*f);g=(int)(pal[i,1]*(1-f)+pal[i+1,1]*f);b=(int)(pal[i,2]*(1-f)+pal[i+1,2]*f);
       double h=Math.Max(0,1-Math.Abs(q+.08*y/rows-(t-2)*.53)/.055)*.84;r+=(int)((255-r)*h);g+=(int)((255-g)*h);b+=(int)((255-b)*h);
      }
     }
     int c=(r<<16)+(g<<8)+b;if(c!=prev){buf.Append(e+"48;2;"+r+";"+g+";"+b+"m");prev=c;}buf.Append(' ');
    }buf.Append(e+"0m\r\n");
   }Console.Write(buf.ToString());if(t>=5)break;Thread.Sleep(45);
  }}finally{Console.Write(e+"0m"+e+"?25h");}
 }
}
'@
$w=if([Console]::IsOutputRedirected){104}else{[Math]::Min(200,[Console]::WindowWidth-1)}
$h=[Math]::Max(8,[Math]::Round($w*.19))
if(-not [Console]::IsOutputRedirected){$h=[Math]::Min($h,[Console]::WindowHeight-2)}
if($h -lt 6 -or $w -lt 45){Write-Host 'Please enlarge the terminal window.';exit 1}
[RetroPCRC]::Play($w,$h)
