import test from "node:test";
import assert from "node:assert/strict";

import {
  collectCommentTreeIds
} from "../routes/study-comment-delete-api.mjs";


test(
  "collectCommentTreeIds includes every nested reply but leaves other threads alone",
  () => {
    const comments = [
      {
        id: "root-a",
        parent_comment_id: null
      },
      {
        id: "reply-a-1",
        parent_comment_id: "root-a"
      },
      {
        id: "reply-a-2",
        parent_comment_id: "root-a"
      },
      {
        id: "reply-a-1-1",
        parent_comment_id: "reply-a-1"
      },
      {
        id: "root-b",
        parent_comment_id: null
      },
      {
        id: "reply-b-1",
        parent_comment_id: "root-b"
      }
    ];

    assert.deepEqual(
      collectCommentTreeIds(
        comments,
        "root-a"
      ),
      [
        "root-a",
        "reply-a-1",
        "reply-a-2",
        "reply-a-1-1"
      ]
    );
  }
);


test(
  "collectCommentTreeIds can delete one reply subtree without deleting its parent",
  () => {
    const comments = [
      {
        id: "root",
        parent_comment_id: null
      },
      {
        id: "reply",
        parent_comment_id: "root"
      },
      {
        id: "nested",
        parent_comment_id: "reply"
      }
    ];

    assert.deepEqual(
      collectCommentTreeIds(
        comments,
        "reply"
      ),
      ["reply", "nested"]
    );
  }
);


test(
  "collectCommentTreeIds returns an empty list for a missing comment and does not loop on bad data",
  () => {
    const comments = [
      {
        id: "a",
        parent_comment_id: "b"
      },
      {
        id: "b",
        parent_comment_id: "a"
      }
    ];

    assert.deepEqual(
      collectCommentTreeIds(
        comments,
        "missing"
      ),
      []
    );

    assert.deepEqual(
      collectCommentTreeIds(
        comments,
        "a"
      ),
      ["a", "b"]
    );
  }
);
