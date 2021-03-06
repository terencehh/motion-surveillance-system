/*
Created by Terence Ng
Updated on 12/06/2020
This main file defines execution program that all client cameras must run in order to toggle live streaming and motion detection of their video cameras.
*/
// express server
const express = require('express');
// configure environment variables
require('dotenv').config();
// for file upload procedure
const busboy = require('connect-busboy')
const busboyBodyParser = require('busboy-body-parser')
// for opencv
const cv = require('opencv4nodejs')
// configure http client
const axios = require('axios')
// cors for allowing cross origin resource sharing between different localhosts
const cors = require("cors")
// initiate server instance
const app = express();
const server = require('http').Server(app)
const io = require('socket.io')(server)
// aws upload module
const aws = require('./s3-file-upload')
// ip address of client
const internalIp = require('internal-ip');
var assert = require('assert');
app.use(busboy())
app.use(busboyBodyParser());
// allow cross origin resource sharing
app.use(cors());
// dont need body parser anymore just do this
app.use(express.json());

// get camera location from input arguments
var myArgs = process.argv.slice(2);
// Assert camera location is provided, otherwise an error is report
assert(cameraLocation = myArgs[0], "Please provide the camera's location")
let vCap;
// Try to open capture from webcam
try {
  vCap = new cv.VideoCapture(0)
}
catch (err) {
  console.log("Camera is not avaiable")
  return
}
// configure the video capture object for streaming
vCap.set(cv.CAP_PROP_FRAME_WIDTH, 300);
vCap.set(cv.CAP_PROP_FRAME_HEIGHT, 300);
const FPS = 10;
doSetup();

/**
 * Performs the action of setting up the video camera and clients asynchronously into MongoDB.
 * Firstly sets up client object and camera object, which uploads to the database server, then proceeding to toggle live streaming and motion detection algorithm.
 * Upon motion detected, a video object will be written then stored onto AWS S3
 * Bucket, with the video file being deleted shortly thereafter
 */
async function doSetup() {
  const testClient = {
    clientName: "Monash University",
    cameras: []
  }
  const ip = internalIp.v4.sync()
  console.log(internalIp.v4.sync())
  const testCameraOne = {
    cameraLocation: cameraLocation,
    cameraURL: `http://${ip}:5100`,
    startTime: {
      hour: "00",
      minute: "00"
    },
    endTime: {
      hour: "00",
      minute: "00"
    },
    motionClips: []
  }

  // POST request to create a new client
  const client = await axios.post('http://161.35.110.201:4200/client', testClient)
  console.log("Client Added: ", client.data._id)
  // POST request to create a new Camera
  const cameraOne = await axios.post('http://161.35.110.201:4200/camera', { ...testCameraOne, cameraClient: client.data._id })
  console.log("Camera Added: ", cameraOne.data._id)
  // add the camera to client camera array
  const camToClientOne = await axios.post('http://161.35.110.201:4200/addcamera', { clientId: client.data._id, cameraId: cameraOne.data._id })
  console.log("Camera Added to Client Camera Array ")

  server.listen(5100, () => {
    console.log(`Client Server Successfully Started on Port ${5100}`);

    //The firstframe will be used to be compared to determine whether a motion is detected, between 2 frames using frame differencing
    var firstFrame;
    //a boolean to determine whether we are writing a video
    var writing = false;
    // the length of the video upon motion detection. Can be adjusted.
    var videoLength = 100;
    // time to write when writing a motion clip
    var currentWrittenTime = 0;
    // writerFile for when motion is detected
    var writerObject;
    // videoName of motion clip file.
    var videoName;

    // define the interval to continuously send frame data to server
    setInterval(() => {
      // vCap.read returns a mat file
      let frame = vCap.read();
      const image = cv.imencode('.jpg', frame).toString('base64')
      io.emit('buildingAFrame', image)

      // perform motion detection algorithm
      // set up variables for motion Detection algorithm
      var today = new Date();
      //The current_time, start_time, end_time variables will be used to determine whether we should stop/start the motion detecting progress based on the time the users put in
      var current_time;
      var start_time, end_time;
      try {
        current_time = Number(today.getHours().toString() + today.getMinutes().toString());
      } catch (error) {
        console.log("Initialising current time failed")
      }
      firstFrame = frame;
      //convert to grayscale and set the first frame
      firstFrame = frame.cvtColor(cv.COLOR_BGR2GRAY);
      firstFrame = firstFrame.gaussianBlur(new cv.Size(21, 21), 0);
      let url = 'http://161.35.110.201:4200/camera/' + cameraOne.data._id;
      axios.get(url).then(res => {
        start_time = generateTime(res.data.startTime)
        end_time = generateTime(res.data.endTime)
        current_time = modifyCurrentDate(today)

        // check if previously motion was detected then keep writing
        if (writing) {
          writeFrame(writerObject, frame)
          currentWrittenTime++;
          if (currentWrittenTime == videoLength) {
            // // writer file is done here
            // reset variables
            let clipName = videoName
            writing = false;
            videoName = undefined;
            writerObject = undefined;
            currentWrittenTime = 0;

            // call upload to s3 here using video file, axios + cameraId
            let file = `./${clipName}`
            // test uploading to AWS
            console.log(`Uploading ${file} to S3`)
            console.log(file)
            //upload the video onto server
            aws.uploadToS3(file, axios, cameraOne.data._id)
          }
        }
        else {
          if (start_time == end_time) {
            if (writing == false) {
              if (motionDetected(frame, firstFrame)) {
                console.log("motion detected");
                writing = true
                var date = today.getFullYear() + (today.getMonth() + 1) + today.getDate() + today.getHours() + today.getMinutes() + today.getSeconds();
                videoName = cameraOne.data._id + date + ".avi";
                writerObject = new cv.VideoWriter(videoName, cv.VideoWriter.fourcc('MJPG'), 10.0, new cv.Size(vCap.get(cv.CAP_PROP_FRAME_WIDTH), vCap.get(cv.CAP_PROP_FRAME_HEIGHT)));
              }
              //reset the first frame to the current frame
              firstFrame = resetFirstFrame(frame);
            }
          }
          else if (start_time < end_time) {
            if (current_time > start_time && current_time < end_time) {
              if (writing == false) {
                if (motionDetected(frame, firstFrame)) {
                  console.log("motion detected");
                  writing = true
                  var date = today.getFullYear() + (today.getMonth() + 1) + today.getDate() + today.getHours() + today.getMinutes() + today.getSeconds();
                  videoName = cameraOne.data._id + date + ".avi";
                  writerObject = new cv.VideoWriter(videoName, cv.VideoWriter.fourcc('MJPG'), 10.0, new cv.Size(vCap.get(cv.CAP_PROP_FRAME_WIDTH), vCap.get(cv.CAP_PROP_FRAME_HEIGHT)));
                }
                firstFrame = resetFirstFrame(frame);
              }
            }
          }
          else if (start_time > end_time) {
            if ((current_time > start_time) || (current_time < end_time)) {
              if (writing == false) {
                if (motionDetected(frame, firstFrame)) {
                  console.log("motion detected");
                  writing = true
                  var date = today.getFullYear() + (today.getMonth() + 1) + today.getDate() + today.getHours() + today.getMinutes() + today.getSeconds();
                  videoName = cameraOne.data._id + date + ".avi";
                  writerObject = new cv.VideoWriter(videoName, cv.VideoWriter.fourcc('MJPG'), 10.0, new cv.Size(vCap.get(cv.CAP_PROP_FRAME_WIDTH), vCap.get(cv.CAP_PROP_FRAME_HEIGHT)));
                }
                firstFrame = resetFirstFrame(frame);
              }
            }
          }
        }
      })
    }, 1000 / FPS)
  })
}


/**
 * write the current frame into a writerObject
 * @param {*} writerObject writerObject which the video file is being made from
 * @param {*} frame a single image frame
 */
function writeFrame(writerObject, frame) {
  writerObject.write(frame)
}

/**
 * Changes the current date object into a number version
 * @param {*} today a Date Object
 * @return {Number} frame a single image frame
 */
function modifyCurrentDate(today) {
  if (today.getMinutes() == 0) {
    return Number(today.getHours().toString() + today.getMinutes().toString() + "0");
  }
  else if (today.getMinutes().toString().length == 1) {
    return Number(today.getHours().toString() + "0" + today.getMinutes().toString());
  }
  else {
    return Number(today.getHours().toString() + today.getMinutes().toString());
  }
}

/**
 * Convert the time from string into integer
 * @param {*} timeObj timeObj: The time object including 2 strings: hour and minute
 * @return {Number} Returns number version of the Date Object
 */
function generateTime(timeObj) {
  time = timeObj.hour + timeObj.minute
  return Number(time)
}

/**
 * Compares two frames to detect if motion has been detected.
 * @param {Mat} frame the current frame that we captured from the camera
 * @param {Mat} firstFrame the first frame that we recorded, this will be the comparison object with the current frame
 * @return {boolean} Returns true or false if motion has been detected
 */
function motionDetected(frame, firstFrame) {
  // convert frame into greyscale
  let grey = (frame.cvtColor(cv.COLOR_BGR2GRAY)).gaussianBlur(new cv.Size(21, 21), 0);
  // frameDelta stores the computed contour after comparing the difference between the 2 frames. It is used to determine whether a motion is detected, between 2 frames
  let frameDelta = firstFrame.absdiff(grey);
  let thresh = (frameDelta.threshold(25, 255, cv.THRESH_BINARY)).dilate(new cv.Mat(), new cv.Vec(-1, -1), 2)
  let cnts = thresh.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (i = 0; i < cnts.length; i++) {
    if (cnts[i].area < 500) { continue }
    return true
  }
  return false
}

/**
 * resets an image frame to the original
 * @param {Mat} frame frame to be reset from
 * @return {Mat} Returns resetted image frame
 */
function resetFirstFrame(frame) {
  return frame.cvtColor(cv.COLOR_BGR2GRAY).gaussianBlur(new cv.Size(21, 21), 0);
}