## Context
read though web/ folder to understand the project context
---
## Task 1: add or modify the following features in the web app
1. add location data to Session, under Practice_Meta, so that I know the location of this practice takes place
2. add a comment field to Session, under Practice_Meta, so that the user can add specific context for this practice session
3. in the device info page, remove the "check for update" button, check for update should be done automatically. Update firmware is only active when the current device version is behine the latest available firmware version. If the device version is equal the latest available firmware version, "update firmware" button should be disabled.
4. on the practice setup page, remove the upload video clips button. Add a page "Upload options" after the user complete the scene labeling. On this page, have a few checkboxes to define the video clips to be uploaded
    a. upload all video clips
    b. upload corrected shots only [default]
    c. upload no video clips
also add a comment field, and the comment there will be uploaded to Practice_Meta. When the use click the upload button, the json files as well as the video clips (if selected) will be uploaded to firebase.
5. I don't want to save or uploade the entire video, and save the shot scenes to individual video clips based on the scene time, and pre_s and post_s, and only upload the clips to Firebase, per the selection. 
