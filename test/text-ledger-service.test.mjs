import test from "node:test";
import assert from "node:assert/strict";

import {
  collectCommentTreeIds
} from "../services/text-ledger-service.mjs";

import {
  resolveLedgerServiceGroup
} from "../services/text-ledger-composite-service.mjs";


test(
  "文字总账删除父评论时会收齐整棵回复树",
  () => {
    const comments = [
      {
        id: "root",
        parent_comment_id: null
      },
      {
        id: "child-a",
        parent_comment_id: "root"
      },
      {
        id: "child-b",
        parent_comment_id: "root"
      },
      {
        id: "grandchild",
        parent_comment_id: "child-a"
      },
      {
        id: "other-root",
        parent_comment_id: null
      }
    ];

    assert.deepEqual(
      collectCommentTreeIds(
        comments,
        "root"
      ),
      [
        "root",
        "child-a",
        "child-b",
        "grandchild"
      ]
    );
  }
);


test(
  "文字总账评论树能防止坏数据循环",
  () => {
    const comments = [
      {
        id: "a",
        parent_comment_id: "c"
      },
      {
        id: "b",
        parent_comment_id: "a"
      },
      {
        id: "c",
        parent_comment_id: "b"
      }
    ];

    assert.deepEqual(
      collectCommentTreeIds(
        comments,
        "a"
      ),
      ["a", "b", "c"]
    );
  }
);


test(
  "总账能把基础文字与机房文字分给正确服务",
  () => {
    assert.equal(
      resolveLedgerServiceGroup(
        "bedroom_message"
      ),
      "core"
    );
    assert.equal(
      resolveLedgerServiceGroup(
        "chat_message"
      ),
      "extra"
    );
    assert.equal(
      resolveLedgerServiceGroup(""),
      "all"
    );

    assert.throws(
      () => resolveLedgerServiceGroup(
        "mystery_drawer"
      ),
      /不认识这种文字来源/
    );
  }
);
