# Dashboard screenshots

The browser tests include pictures of the Options desk (`dashboard/test/e2e/visual.spec.ts`): the three views and a
name's own page, dark and light on a desktop, dark on a phone. Each run draws them from fixture data with the clock
stood still and no live feed, and compares them with the committed pictures in
`dashboard/test/e2e/__screenshots__/`. A change that moves, recolours or drops something fails the `dashboard
checks` job.

The pictures are made on the CI runner and nowhere else: browsers are kept off the owner's Mac, and a picture made
on another machine differs in its fonts by a few pixels.

## When a picture is meant to change

1. Open the failed run. The artifact `playwright-report` shows the old picture, the new one and the difference.
2. If the new one is right, download the artifact `screenshots` from the same run: it holds every picture as this
   commit draws it.

   ```
   gh run download <run id> --name screenshots --dir dashboard/test/e2e/__screenshots__
   ```
3. Commit the changed files on the same branch and push. The comparison then passes.

A picture that changes when nothing was meant to is the finding: fix the code, not the picture.

## What is left out of the pictures

- The site's own header: its clocks run and its feed pills age.
- Live prices: the pictures are taken with the live feed off.
- Hover and focus states, the command palette, and every failure state. Those are covered by the other browser
  tests, which check what is on the page, not how it looks.
