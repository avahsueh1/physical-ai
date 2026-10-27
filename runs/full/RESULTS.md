# Results: preset `full`

Training courses: 5 families x 80 seeds. Held-out evaluation: 30 *new* seeds per family. Safety budget tau = 0.3.

## Success rate on held-out courses

```
controller                       gaps  corridor    slopes    rubble     mixed       ALL   failures (all)
expert                           100%      100%       93%       83%       90%       93%   stuck:10
random                            57%       77%       87%       13%       50%       57%   stuck:52, wedged:13
daredevil                         57%      100%       93%       83%       90%       85%   stuck:10, wedged:13
safe:daredevil                    97%      100%       93%       83%       90%       93%   stuck:10, wedged:1
policy:policy_tiny               100%      100%       93%       47%       57%       79%   stuck:31
safe:policy:policy_tiny          100%      100%       93%       47%       57%       79%   stuck:31
policy:policy_small              100%      100%       93%       33%       67%       79%   stuck:32
safe:policy:policy_small         100%      100%       93%       33%       67%       79%   stuck:32
policy:policy_medium             100%      100%       93%       53%       50%       79%   stuck:31
safe:policy:policy_medium        100%      100%       93%       50%       50%       79%   stuck:32
```

* `expert` uses privileged info (the course map); everything else only sees the robot's own sensors,
  except `daredevil`, which is the expert blinded to tunnel height (a stand-in for a reckless
  high-level command such as 'go forward' from a language model).
* `safe:X` = controller X wrapped in the world-model safety filter.

## World model

```
{
 "train": {
  "what_if_moments": 10145,
  "failing_moves": 0.0383,
  "risk_auc": 1.0,
  "mixed_moments": 178,
  "picks_a_safe_move_in_mixed": 0.972
 },
 "validation (unseen courses)": {
  "what_if_moments": 1425,
  "failing_moves": 0.0564,
  "risk_auc": 0.98,
  "mixed_moments": 59,
  "picks_a_safe_move_in_mixed": 0.814
 },
 "successor features: corr(psi.w, true return) on unseen courses": {
  "make progress": 0.829,
  "keep clear of obstacles": 0.836
 }
}
```

## Controllers

* tiny: 805 parameters (3.1 KB as float32) -> `policy_tiny.h`
* small: 2117 parameters (8.3 KB as float32) -> `policy_small.h`
* medium: 6277 parameters (24.5 KB as float32) -> `policy_medium.h`

## Time (s)

```
{
 "data": 0,
 "world": 0,
 "policy_tiny": 0,
 "policy_small": 0,
 "policy_medium": 0,
 "evaluate": 553
}
```
