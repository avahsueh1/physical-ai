import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root=Path(__file__).resolve().parent
data=json.loads((root/'results/sweep.json').read_text())
fig,axes=plt.subplots(1,2,figsize=(11,5))
fig.subplots_adjust(top=.76,bottom=.24,wspace=.38)
for ax,key,title in zip(axes,['bodyLengthsPerCycle','positiveCableWork'],
                       ['Forward progress (body lengths / cycle)','Positive cable work (model units)']):
    grid=[[next(r['metrics'][key] for r in data['rows'] if r['config']['foldScale']==s and r['config']['frictionScale']==f)
           for f in [.25,1,2]] for s in [.5,1,2]]
    im=ax.imshow(grid,origin='lower',cmap='YlGnBu',aspect='auto')
    for y,row in enumerate(grid):
        for x,v in enumerate(row):
            ax.text(x,y,f'{v:.3f}',ha='center',va='center',color='white' if im.norm(v)>.6 else 'black')
    ax.set_xticks([0,1,2],['0.25×','1×','2×'])
    ax.set_yticks([0,1,2],['0.5×','1×','2×'])
    ax.set_xlabel('Ground-friction multiplier')
    ax.set_ylabel('Fold-stiffness multiplier')
    ax.set_title(title,fontsize=11)
    fig.colorbar(im,ax=ax,shrink=.8)
fig.suptitle('Crawler: friction × fold stiffness',fontsize=18,y=.96)
fig.text(.125,.85,'Crease Lab model · fixed inchworm gait and cable force · 3 measured cycles',fontsize=11)
fig.text(.125,.10,'Directional friction ratio held fixed; axial/facet stiffness unchanged. No hardware calibration.',fontsize=9)
fig.text(.125,.05,'One deterministic run per condition. Cable work excludes motor losses and is not battery energy.',fontsize=9)
for ext in ['png','pdf','svg']:fig.savefig(root/f'results/friction-stiffness.{ext}',dpi=180)
print('Saved friction-stiffness plots')
