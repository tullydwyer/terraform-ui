module "example" {
  source = "./tfm-example"
  name = local_file.file_1.content
  name2 = local_file.file_2.content
}

resource "local_file" "file_1" {
  content  = "${local.environment}_name_1"
  filename = "out/${local.environment}_root_file_1.bar"
}

resource "local_file" "file_2" {
  content  = "${local.environment}_name_2"
  filename = "out/${local.environment}_root_file_2.bar"
}

# resource "local_file" "file_3" {
#   content  = "${local.environment}_name_3"
#   filename = "out/${local.environment}_root_file_3.bar"
# }