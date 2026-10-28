"""Render genuine simulator trajectories as a fixed-camera oblique wireframe GIF."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parent
data=json.loads((root/'results/replay.json').read_text())
def font(size):
    for name in ['C:/Windows/Fonts/arial.ttf', 'DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        try:
            return ImageFont.truetype(name,size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)
big,medium,small=font(29),font(20),font(16)
frames=[]
colors=['#a66a31','#087f78']
for k in range(361):
    im=Image.new('RGB',(1100,650),'#f8f8f5');d=ImageDraw.Draw(im)
    d.text((35,20),'How the crawler moves',font=big,fill='#18252a')
    d.text((35,60),'Recorded Crease Lab dynamics | same gait and cable force | fixed camera',font=small,fill='#526169')
    for i,r in enumerate(data['recordings']):
        f=r['frames'][k]; ybase=280+i*250; color=colors[i]
        def project(x,y,z): return (240+(x-r['origin'][0])*75-y*18,ybase+y*12-z*62)
        d.text((35,100+i*250),['Default: stiffness 1x, friction 1x','Best tested: stiffness 2x, friction 0.25x'][i],font=medium,fill=color)
        for x in range(-2,9):
            a=project(r['origin'][0]+x,-1.8,0);b=project(r['origin'][0]+x,1.8,0)
            d.line([a,b],fill='#deded7',width=1)
        for y in [-1.8,0,1.8]:d.line([project(r['origin'][0]-2,y,0),project(r['origin'][0]+8,y,0)],fill='#deded7',width=1)
        p=f['positions'];points=[project(*p[j:j+3]) for j in range(0,len(p),3)]
        for a,b in r['edges']: d.line([points[a],points[b]],fill='#bdc7c9',width=1)
        for a,b in r['bodyEdges']: d.line([points[a],points[b]],fill=color,width=2)
        for x,y in points:d.ellipse((x-2,y-2,x+2,y+2),fill=color)
        d.text((770,155+i*250),f['phase'],font=medium,fill=color)
        d.text((770,190+i*250),f"Forward: {f['progress']:.2f} body lengths",font=small,fill='#18252a')
        d.text((770,218+i*250),f"Model time: {f['time']:.2f} / 18",font=small,fill='#526169')
    d.text((35,605),'Wireframe replay, not hardware footage. Uncalibrated model; grid and camera scale are identical.',font=small,fill='#526169')
    frames.append(im)
frames[180].save(root/'results/crawler-preview.png')
frames[0].save(root/'results/crawler-comparison.gif',save_all=True,append_images=frames[1:],duration=50,loop=0,optimize=False)
print('Saved crawler-comparison.gif and crawler-preview.png')
