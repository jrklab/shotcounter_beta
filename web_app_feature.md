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


## Task 2: separate shot scene trigger and shot classification, modify the current code structure
1. A running shot scene detector go through every MPU samples and ToF samples, if the magnitude of acceleration is larger than certain threshold, or the ToF range and ToF signal rate is beyond certain threshold, a shot scene is triggered. the Time stamp of the MPU or TOF event will be recorded as T0, the MPU and TOF data within T0-pre_s and T0+post_s will be send to a classifer to determine whether it is miss or make or not a shot. The threshold are independent and configurable in the code. The scene window should not overlap with each other. pre_s = 0.5s, and post_s = 1.5s, and also configurable. 
2. for there are two classifers available, Classic classifier is the current mode based on state machine and threshold. Learned classifier is a ML model, using 1D-cnn, defined in ml/ folder with the weights specified in ml/artifacts/model_cnn_primary.pt. For now, let's only focus on primary classifier. 
3. On the practice setup page, below camera enable, add two classifier options, Classic  and Learned. By default it is Classic. 
4. Based on the learned model, estimate the computation time for each shot scene. and estimate the detection latency. 

## Task 3: 
1. add a discard button between "go back" and "confirm" in shot review page, to discard certain shot scene during review, and move to review the next scene. The discarded scene doesn't need to be included in session or shot json. 
2. add classifier type into session json on firestore, so that I know which classifier is used in this session