module "example" {
  source = "./tfm-example"
  name = local_file.file_1.content
  name2 = local_file.file_2.content
}

resource "local_file" "file_1" {
  content  = "${var.myname}_name_1"
  filename = "out/${var.myname}_root_file_1.bar"
}

resource "local_file" "file_2" {
  content  = "${local.environment}_name_2s"
  filename = "out/${local.environment}_root_file_2.bar"
}

resource "local_file" "file_3" {
  for_each = toset(["a", "b", "c"])

  content  = "${local.environment}_name_${each.value}"
  filename = "out/${local.environment}_root_file_${each.value}.bar"
}